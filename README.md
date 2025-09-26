# zjmf-monitor

Long Polling 版 Telegram 库存监控（**单文件 `app.js` 运行 / Docker 镜像运行 / Render Web Service**）。

- 🌐 无需 Webhook/反代/HTTPS（长轮询）
- 🔔 补货/缺货消息 **开启提醒**（`notify: true`）
- 🧹 自动清理与保活：
  - 缺货（库存=0）：立刻删旧“补货”消息 → 发送“无库存”消息 → **2 分钟后自动删除**
  - 补货消息 **5 分钟内无变化** 自动删除（有变化会续期）
  - 汇总：**每 2 分钟自动刷新**；若所有库存均为 0，**10 分钟后自动删除**（期间若出现>0会取消删除）
  - 内置 `/healthz` 保活端口（Render Web Service 友好）

---

## 环境变量

> **粗体为必填**

| 变量 | 必填 | 说明 |
|---|---|---|
| **`BOT_TOKEN`** | 是 | Telegram Bot Token（请通过环境变量注入，**不要写入仓库**） |
| **`CHAT_IDS`** | 是 | 接收通知的 chat id 列表。支持 JSON 数组或逗号分隔，例如：`["7032984555","-1002982183974"]` |
| **`TARGETS_JSON`** | 是 | 监控目标（仅此来源）。JSON 数组，每项至少包含 `url`，可选 `titleRegex` |
| `INTERVAL_MS` | 否 | 轮询间隔，默认 `5000` |
| `DELETE_AFTER_SOLDOUT_SEC` | 否 | 无库存消息自动删除秒数，默认 `120` |
| `RESTOCK_IDLE_DELETE_SEC` | 否 | 补货消息无变化自动删除秒数，默认 `300` |
| `SUMMARY_REFRESH_SEC` | 否 | 汇总自动刷新秒数，默认 `120` |
| `SUMMARY_DELETE_IF_ALL_ZERO_SEC` | 否 | 汇总全 0 时自动删除秒数，默认 `600` |
| `PORT` | 否 | Web Service 保活端口（Render 会自动注入；本地可自定义以便健康检查） |

### `TARGETS_JSON` 示例
```json
[
  {"url":"https://bymail.nyc.mn/cart?fid=2&gid=2","titleRegex":"(香港\\s*HK[^<]{0,40})"},
  {"url":"https://bymail.nyc.mn/cart?fid=2&gid=8","titleRegex":"(法国\\s*FR[^<]{0,40})"},
  {"url":"https://bymail.nyc.mn/cart?fid=2&gid=9","titleRegex":"(德国\\s*DE[^<]{0,40})"},
  {"url":"https://idc.yizong.de/cart?fid=1&gid=1","titleRegex":"(香港\\s*HK[^<]{0,40})"}
]
