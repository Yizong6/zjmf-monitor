// src/app.mjs
/**
 * zjmf-monitor — Render Web Service 保活 + 业务规则强化
 *
 * 需求实现：
 * 1) 售罄（库存=0）：立即删除旧“补货”消息，发送“无库存”消息；无库消息 2 分钟后自动删除
 * 2) 补货消息在“内容无变化”时，5 分钟后自动删除（有变化则续期）
 * 3) 汇总消息：若有任一库存>0则不删除；每2分钟自动刷新；
 *    若刷新后全部为0，则10分钟后自动删除；期间若再次出现库存>0则取消删除计划
 * 4) 美化通知格式（HTML）
 */

import http from "node:http";
import fetch from "node-fetch";

// --- keepalive HTTP server for Render Web Service ---
const PORT = process.env.PORT ? Number(process.env.PORT) : 0;
if (PORT) {
  const server = http.createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok\n");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("zjmf-monitor running\n");
  });
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`HTTP keepalive listening on :${PORT}`);
  });
} else {
  console.log("PORT not set; running without HTTP keepalive (worker-style).");
}
// --- end keepalive ---

// ===== 配置（来自环境变量）=====
const BOT_TOKEN = process.env.BOT_TOKEN || "";
if (!BOT_TOKEN) {
  console.error("ERROR: BOT_TOKEN 环境变量未设置。");
  process.exit(1);
}

const CHAT_IDS = (() => {
  const raw = process.env.CHAT_IDS || "";
  if (!raw) {
    console.error("ERROR: CHAT_IDS 未设置。至少提供一个 chat id（私聊或群组）。");
    process.exit(1);
  }
  try {
    if (raw.trim().startsWith("[")) return JSON.parse(raw);
    return raw.split(",").map(s => s.trim()).filter(Boolean);
  } catch {
    console.error("ERROR: CHAT_IDS 格式不正确，应为 JSON 数组或逗号分隔字符串。");
    process.exit(1);
  }
})();

const INTERVAL_MS = Number(process.env.INTERVAL_MS || 5000);
// 2 分钟删除无库存消息
const DELETE_AFTER_SOLDOUT_SEC = Number(process.env.DELETE_AFTER_SOLDOUT_SEC || 120);
// 5 分钟内若补货消息无变化则删除
const RESTOCK_IDLE_DELETE_SEC = Number(process.env.RESTOCK_IDLE_DELETE_SEC || 300);
// 汇总每 2 分钟自动刷新
const SUMMARY_REFRESH_SEC = Number(process.env.SUMMARY_REFRESH_SEC || 120);
// 汇总全部为 0 时，10 分钟后自动删除
const SUMMARY_DELETE_IF_ALL_ZERO_SEC = Number(process.env.SUMMARY_DELETE_IF_ALL_ZERO_SEC || 600);

// —— 仅从环境变量读取监控目标（必填）——
let TARGETS;
try {
  const raw = process.env.TARGETS_JSON;
  if (!raw) {
    console.error("ERROR: TARGETS_JSON 未设置。请提供 JSON 数组，例如：[{\"url\":\"...\",\"titleRegex\":\"...\"}]");
    process.exit(1);
  }
  TARGETS = JSON.parse(raw);
  if (!Array.isArray(TARGETS) || TARGETS.length === 0) {
    console.error("ERROR: TARGETS_JSON 解析结果为空数组。");
    process.exit(1);
  }
  for (const t of TARGETS) {
    if (!t?.url) {
      console.error("ERROR: TARGETS_JSON 中存在缺少 url 的条目。");
      process.exit(1);
    }
  }
} catch (e) {
  console.error("ERROR: 无法解析 TARGETS_JSON：", e?.message || e);
  process.exit(1);
}

// ===== 内存状态 =====
let stockCache = {};                  // { key: lastStock }
let notifiedRestock = {};             // { key: true } 本补货周期只提醒一次（售罄后清空）
let lastRestockMsg = {};              // { chat_id: { key: msg_id } } 当前“在售期”消息
let pendingDeletes = [];              // [{chat_id, msg_id, due, kind, key?}]
let lastSummaryMsg = {};              // { chat_id: msg_id }
let lastSummaryRefreshAt = {};        // { chat_id: timestamp } 上次自动刷新时间
let pollOffset = 0;                   // getUpdates offset
let stopFlag = false;                 // 优雅退出

// ===== 工具 =====
const UA = { "User-Agent":"Mozilla/5.0", "Accept-Language":"zh-CN,zh;q=0.9" };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const esc = (s)=>String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function cnNow() {
  const d = new Date();
  const fmt = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false
  }).formatToParts(d).reduce((o,p)=> (o[p.type]=p.value,o),{});
  return `${fmt.year}-${fmt.month}-${fmt.day} ${fmt.hour}:${fmt.minute}:${fmt.second}`;
}
const hostname = (u)=>{ try { return new URL(u).hostname; } catch { return u; } };
const brandOf = (u)=>{
  const h = hostname(u);
  const p = h.split(".").filter(Boolean);
  const common = new Set(["www","idc","shop","app","api","cart","store"]);
  const pick = (p.length>=2 && common.has(p[0])) ? p[p.length-2] : p[0];
  return (pick||h).toUpperCase();
};
const alink = (u,t)=>`<a href="${String(u).replace(/"/g,"&quot;")}">${t}</a>`;

// === 美化模板 ===
const line = "━━━━━━━━━━━━━━━━━━━━";
const titleBanner = (t) => `🧩 <b>ZJMF 监控</b> ｜ <b>${t}</b>\n${line}`;
const kv = (k, v) => `• <b>${k}：</b>${v}`;

function fmtRestock(brand, title, last, curr) {
  const head = titleBanner("库存变动提醒");
  const status = `🟢 <b>状态：</b>补货　　📦 <b>库存：</b>${curr}`;
  const change = `↕️ <b>变化：</b>${(last ?? "-")} ➜ ${curr}`;
  const time = `🕒 <b>时间：</b>${cnNow()}`;
  return `${head}
${kv("商家", brand)}
${kv("商品", esc(title))}
${status}
${change}
${time}`;
}

function fmtSoldout(brand, title, last, curr) {
  const head = titleBanner("缺货提醒");
  const status = `🔴 <b>状态：</b>缺货　　📦 <b>库存：</b>0`;
  const change = `↕️ <b>变化：</b>${(last ?? "-")} ➜ ${curr}`;
  const time = `🕒 <b>时间：</b>${cnNow()}`;
  return `${head}
${kv("商家", brand)}
${kv("商品", esc(title))}
${status}
${change}
${time}`;
}

function fmtSummaryHeader() {
  return `${titleBanner("实时库存汇总")}  
⏱ 每 2 分钟自动刷新`;
}

// ===== Telegram API（Long Polling）=====
async function tgDeleteWebhookIfAny(){ try{ await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/deleteWebhook`,{method:"POST"}); }catch{} }
async function tgSend(chat_id,text,{kb=null, notify=undefined}={}) {
  const api=`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const payload={ chat_id, text, parse_mode:"HTML", disable_web_page_preview:true };
  if (kb) payload.reply_markup = { inline_keyboard: kb };
  if (typeof notify === "boolean") payload.disable_notification = !notify;
  const r=await fetch(api,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
  const d=await r.json().catch(()=>({}));
  return d?.result?.message_id;
}
async function tgEdit(chat_id,message_id,text,{kb=null}={}) {
  const api=`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`;
  const payload={ chat_id, message_id, text, parse_mode:"HTML", disable_web_page_preview:true };
  if(kb) payload.reply_markup={ inline_keyboard: kb };
  await fetch(api,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
}
async function tgDelete(chat_id,message_id){
  const api=`https://api.telegram.org/bot${BOT_TOKEN}/deleteMessage`;
  await fetch(api,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({chat_id,message_id})});
  if(lastSummaryMsg[chat_id]===message_id) delete lastSummaryMsg[chat_id];
  if(lastRestockMsg[chat_id]) {
    for (const k of Object.keys(lastRestockMsg[chat_id])) {
      if (lastRestockMsg[chat_id][k]===message_id) delete lastRestockMsg[chat_id][k];
    }
  }
}
async function tgAnswer(cb_id,text=""){ 
  const api=`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`;
  await fetch(api,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({callback_query_id:cb_id,text})});
}

// ===== Long Polling =====
async function pollUpdatesLoop(){
  while(!stopFlag){
    try{
      const r=await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?timeout=30&offset=${pollOffset}`);
      const data=await r.json().catch(()=>({}));
      if(data?.result?.length){
        for(const upd of data.result){
          pollOffset = upd.update_id + 1;
          await handleUpdate(upd);
        }
      }
    }catch{}
    await sleep(400);
  }
}

async function handleUpdate(upd){
  const cb = upd.callback_query;
  if(!cb) return;
  const chat_id = String(cb.message.chat.id);
  if(cb.data==="SUMMARY_NEW"){
    await tgAnswer(cb.id,"正在生成新汇总…").catch(()=>{});
    if (lastSummaryMsg[chat_id]) {
      try { await tgDelete(chat_id, lastSummaryMsg[chat_id]); } catch {}
      delete lastSummaryMsg[chat_id];
    }
    const { text, kb, hasAnyStock } = await buildSummaryText();
    const mid = await tgSend(chat_id, text, { kb });
    if (mid) {
      lastSummaryMsg[chat_id] = mid;
      lastSummaryRefreshAt[chat_id] = Date.now();
      scheduleOrCancelSummaryDelete(chat_id, mid, hasAnyStock);
    }
  } else if (cb.data==="SUMMARY_REFRESH"){
    await tgAnswer(cb.id,"已刷新").catch(()=>{});
    const { text, kb, hasAnyStock } = await buildSummaryText();
    const mid = lastSummaryMsg[chat_id];
    if (mid) {
      try { await tgEdit(chat_id, mid, text, { kb }); } catch {}
      lastSummaryRefreshAt[chat_id] = Date.now();
      scheduleOrCancelSummaryDelete(chat_id, mid, hasAnyStock);
    } else {
      const newMid = await tgSend(chat_id, text, { kb });
      if (newMid) {
        lastSummaryMsg[chat_id] = newMid;
        lastSummaryRefreshAt[chat_id] = Date.now();
        scheduleOrCancelSummaryDelete(chat_id, newMid, hasAnyStock);
      }
    }
  }
}

// ===== 抓取 & 解析 =====
async function fetchHtml(url){
  const r = await fetch(url,{headers:UA});
  if(!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.text();
}

/** 增强标题识别（优先局部 titleRegex，其次全局同序，再次常见容器） */
function parseItems(html, titleRegex){
  const items=[]; const stockRe=/库存\s*[:：]\s*(\d+)/gi;
  let titleRe=null;
  if(titleRegex){ try{ titleRe=new RegExp(titleRegex,"gi"); }catch{} }
  const globalTitles=[];
  if(titleRe){
    let mt; while((mt=titleRe.exec(html))!==null){
      const idx=mt.index; const text=(mt[1]||mt[0]||"").toString().trim();
      globalTitles.push({idx,text});
    }
  }
  let m, idxItem=0;
  while((m=stockRe.exec(html))!==null){
    const stock=parseInt(m[1],10); const pos=m.index; let title="";
    if(titleRegex){
      const localRe=new RegExp(titleRegex,"i");
      const ctx=html.slice(Math.max(0,pos-2000),pos+400);
      const lm=localRe.exec(ctx); if(lm && lm[1]) title=lm[1].trim();
    }
    if(!title && globalTitles[idxItem]?.text){ title=globalTitles[idxItem].text; }
    if(!title){
      const win=html.slice(Math.max(0,pos-1000),pos);
      const h = win.match(/<h[1-6][^>]*>\s*([^<]{2,80})<\/h[1-6]>/i)
             || win.match(/<div[^>]*class=["'][^"']*(?:card-title|product-title|plan-name)[^"']*["'][^>]*>\s*([^<]{2,120})<\/div>/i)
             || win.match(/data-title=["']([^"']{2,120})["']/i);
      if(h && h[1]) title=h[1].trim();
    }
    if(!title) title=`条目#${idxItem+1}`;
    items.push({ title, stock: Number.isFinite(stock)?stock:0 });
    idxItem++;
  }
  return items;
}

// ===== 计划删除工具（缺货、在售闲置、汇总）=====
function scheduleDelete(chat_id, msg_id, secs, kind, key){
  pendingDeletes.push({ chat_id, msg_id, due: Date.now() + secs * 1000, kind, key });
}
function cancelDeletes(filterFn){
  pendingDeletes = pendingDeletes.filter(x => !filterFn(x));
}
function scheduleOrRenewRestockIdle(chat_id, msg_id, key, secs){
  cancelDeletes(x => x.kind==="restock_idle" && x.chat_id===chat_id && x.key===key);
  scheduleDelete(chat_id, msg_id, secs, "restock_idle", key);
}
function scheduleOrCancelSummaryDelete(chat_id, msg_id, hasAnyStock){
  // 有库存：取消任何汇总删除；无库存：10 分钟后删除
  cancelDeletes(x => x.kind==="summary" && x.chat_id===chat_id);
  if (!hasAnyStock) scheduleDelete(chat_id, msg_id, SUMMARY_DELETE_IF_ALL_ZERO_SEC, "summary");
}
async function runPendingDeletes(){
  if(!pendingDeletes.length) return;
  const now = Date.now(); const keep=[];
  for(const it of pendingDeletes){
    if(now>=it.due){
      try{ await tgDelete(it.chat_id, it.msg_id); }catch{}
    } else keep.push(it);
  }
  pendingDeletes = keep;
}

// ===== 主循环（5秒）=====
async function checkAll(){
  for(const t of TARGETS){
    try{
      const html = await fetchHtml(t.url);
      const items = parseItems(html, t.titleRegex);
      const brand = brandOf(t.url);

      for(const it of items){
        const key  = `${t.url}#${it.title}`;
        const last = stockCache[key];
        const curr = it.stock;
        stockCache[key] = curr;

        const restocked = typeof last==="number" && last===0 && curr>0;
        const soldout   = typeof last==="number" && last>0 && curr===0;

        if(restocked || soldout){
          const kbInStock = [
            [{ text:"🛒 立即购买", url:t.url }],
            [{ text:"📊 查看汇总", callback_data:"SUMMARY_NEW" }]
          ];
          const kbOutStock = [
            [{ text:"📊 查看汇总", callback_data:"SUMMARY_NEW" }]
          ];

          if(soldout){
            // 1) 删除旧“补货”消息
            for(const chat_id of CHAT_IDS){
              const midOld = lastRestockMsg[chat_id]?.[key];
              if(midOld){ try{ await tgDelete(chat_id, midOld); }catch{} }
              if(lastRestockMsg[chat_id]) delete lastRestockMsg[chat_id][key];

              // 2) 发送“无库存”消息（2 分钟后删除）
              const text = fmtSoldout(brand, it.title, last, curr);
              const mid = await tgSend(chat_id, text, { kb: kbOutStock, notify: true });
              if(mid) scheduleDelete(chat_id, mid, DELETE_AFTER_SOLDOUT_SEC, "soldout");
            }
            // 解锁补货周期
            delete notifiedRestock[key];

          }else if(restocked){
            // 新“在售期”消息，并设置 5 分钟无变化自动删除
            for(const chat_id of CHAT_IDS){
              if(notifiedRestock[key]) continue; // 本补货周期只提醒一次
              const text = fmtRestock(brand, it.title, last, curr);
              const mid = await tgSend(chat_id, text, { kb: kbInStock, notify: true });
              if(mid) {
                (lastRestockMsg[chat_id] ||= {})[key] = mid;
                scheduleOrRenewRestockIdle(chat_id, mid, key, RESTOCK_IDLE_DELETE_SEC);
              }
            }
            notifiedRestock[key] = true;
          }
        } else {
          // 在售期间库存变化：仅编辑“在售期”消息；并续期 5 分钟无变化删除
          if (typeof last==="number" && last!==curr && curr>0){
            const kbInStock = [
              [{ text:"🛒 立即购买", url:t.url }],
              [{ text:"📊 查看汇总", callback_data:"SUMMARY_NEW" }]
            ];
            const text = fmtRestock(brand, it.title, last, curr);
            for(const chat_id of CHAT_IDS){
              const mid = lastRestockMsg[chat_id]?.[key];
              if(mid){
                try{ await tgEdit(chat_id, mid, text, { kb: kbInStock }); }
                catch{
                  const newMid = await tgSend(chat_id, text, { kb: kbInStock });
                  if(newMid) (lastRestockMsg[chat_id] ||= {})[key] = newMid;
                }
                const currentMid = lastRestockMsg[chat_id]?.[key];
                if(currentMid) scheduleOrRenewRestockIdle(chat_id, currentMid, key, RESTOCK_IDLE_DELETE_SEC);
              }
            }
          }
        }
      }
    }catch(e){
      // 可选：console.error("Fetch error:", t.url, e.message);
    }
  }

  await autoRefreshSummaries();
  await runPendingDeletes();
}

// ===== 汇总文本 =====
async function buildSummaryText(){
  const groups = {}; // brand -> [{url, items}]
  let hasAnyStock = false;

  for(const t of TARGETS){
    const brand = brandOf(t.url);
    try{
      const html = await fetchHtml(t.url);
      const items = parseItems(html, t.titleRegex);
      if (items.some(x => x.stock > 0)) hasAnyStock = true;
      (groups[brand] ||= []).push({ url:t.url, items });
    }catch(e){
      (groups[brand] ||= []).push({ url:t.url, error:e.message });
    }
  }

  let text = `${fmtSummaryHeader()}\n\n`;
  const brands = Object.keys(groups).sort();
  for(const b of brands){
    text += `🏪 <b>${b}</b>\n`;
    for(const s of groups[b]){
      if(s.error){ text += `  • ❗<i>${esc(s.error)}</i>\n`; continue; }
      for(const it of s.items){
        const dot = it.stock > 0 ? "🟢" : "⚪";
        text += `  ${dot} <b>${esc(it.title)}</b>：<code>${it.stock}</code>　${alink(s.url,"购买")}\n`;
      }
    }
    text += `\n`;
  }
  text += `🕒 <b>更新时间：</b>${cnNow()}`;

  const kb = [[
    { text:"🔄 刷新库存", callback_data:"SUMMARY_REFRESH" }
  ]];
  return { text, kb, hasAnyStock };
}

// ===== 汇总自动刷新（每 2 分钟）=====
async function autoRefreshSummaries(){
  const now = Date.now();
  for (const chat_id of Object.keys(lastSummaryMsg)) {
    const last = lastSummaryRefreshAt[chat_id] || 0;
    if (now - last >= SUMMARY_REFRESH_SEC * 1000) {
      try {
        const { text, kb, hasAnyStock } = await buildSummaryText();
        const mid = lastSummaryMsg[chat_id];
        if (mid) {
          await tgEdit(chat_id, mid, text, { kb });
          lastSummaryRefreshAt[chat_id] = now;
          scheduleOrCancelSummaryDelete(chat_id, mid, hasAnyStock);
        }
      } catch {}
    }
  }
}

// ===== 启动 & 优雅退出 =====
async function main(){
  console.log("启动：zjmf-monitor（Long Polling, Docker/Render Web Service）");
  await tgDeleteWebhookIfAny().catch(()=>{});
  pollUpdatesLoop().catch(()=>{});
  while(!stopFlag){
    await checkAll().catch(()=>{});
    await sleep(INTERVAL_MS);
  }
  console.log("退出：任务停止。");
}

process.on("SIGTERM", ()=>{ stopFlag = true; });
process.on("SIGINT",  ()=>{ stopFlag = true; });

main().catch(err=>{
  console.error("Fatal:", err);
  process.exit(1);
});
