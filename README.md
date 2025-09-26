# zjmf-monitor

Long Polling 版 Telegram 库存监控（**Docker 镜像部署**）。

- 🌐 无需 Webhook/反代/HTTPS（使用 Long Polling）
- 🐳 直接拉取并运行镜像：`docker.io/yizong6/zjmf-monitor:1.0`
- 🔔 补货/缺货消息 **开启提醒**（`notify: true`）
- 📊 汇总消息支持自动刷新与智能删除（见下方规则）

### 消息与汇总规则（内置）
1) **售罄（库存=0）**：立刻删除旧「补货」消息 → 发送「无库存」消息；无库存消息 **2 分钟**后自动删除  
2) **补货消息无变化**：**5 分钟**后自动删除（若库存变化会续期）  
3) **汇总消息**：若有任一库存 > 0 则 **不删除**，并 **每 2 分钟自动刷新**；若刷新后全部为 0，则 **10 分钟**后自动删除（期间如出现 >0 会取消删除）

---

## 环境变量（必须）

| 变量 | 必填 | 说明 |
|---|---|---|
| `BOT_TOKEN` | 是 | Telegram Bot Token（**不要提交到仓库**） |
| `CHAT_IDS` | 是 | 接收通知的 chat id 列表（JSON 数组或逗号分隔），如：`["7032984555","-1002982183974"]` |
| `TARGETS_JSON` | 是 | **监控目标（仅此来源）**，JSON 数组，项包含 `url` 与可选 `titleRegex` |
| `INTERVAL_MS` | 否 | 轮询间隔（默认 `5000`） |
| `DELETE_AFTER_SOLDOUT_SEC` | 否 | **无库存消息**自动删除秒数（默认 `120`） |
| `RESTOCK_IDLE_DELETE_SEC` | 否 | **补货消息无变化**自动删除秒数（默认 `300`） |
| `SUMMARY_REFRESH_SEC` | 否 | **汇总消息**自动刷新秒数（默认 `120`） |
| `SUMMARY_DELETE_IF_ALL_ZERO_SEC` | 否 | 汇总全部为 0 时自动删除秒数（默认 `600`） |
| `PORT` | 否 | Web Service 保活端口；本地可自定义（Render 会自动注入） |

### `TARGETS_JSON` 示例
```json
[
  {"url":"https://bymail.nyc.mn/cart?fid=2&gid=2","titleRegex":"(香港\\s*HK[^<]{0,40})"},
  {"url":"https://bymail.nyc.mn/cart?fid=2&gid=8","titleRegex":"(法国\\s*FR[^<]{0,40})"},
  {"url":"https://bymail.nyc.mn/cart?fid=2&gid=9","titleRegex":"(德国\\s*DE[^<]{0,40})"},
  {"url":"https://idc.yizong.de/cart?fid=1&gid=1","titleRegex":"(香港\\s*HK[^<]{0,40})"}
]
