# zjmf-monitor

监控目标网页的“库存”文本并通过 **Telegram Bot** 推送补货/缺货提醒与汇总信息。支持 Render Web Service 部署（带 `/healthz`）。

## ✨ 功能
- 库存从 `0 ➜ >0`：发送“补货”消息（同一补货周期只提醒一次）
- 库存从 `>0 ➜ 0`：删除旧“补货”消息并发送“缺货”消息（2 分钟后自动删除）
- 在售期内库存变化：自动编辑“补货”消息并续期（5 分钟无变化自动删除）
- 汇总消息：
  - 有任一库存 `>0` 不删除；
  - 每 2 分钟自动刷新；
  - 若刷新后全部为 `0`，则 10 分钟后自动删除；期间若再次出现库存 `>0` 则取消删除计划
- HTML 美化通知与内联按钮（购买/刷新/查看汇总）
- Render 保活 HTTP 服务：`/healthz`

## 📦 项目结构
```
zjmf-monitor/
├─ src/
│  └─ app.mjs
├─ .github/
│  └─ workflows/
│     └─ docker.yml
├─ .dockerignore
├─ .env.example
├─ Dockerfile
├─ package.json
└─ render.yaml
```

## ⚙️ 环境变量
见 [.env.example](./.env.example)。至少需要：
- `BOT_TOKEN`：Telegram 机器人 token
- `CHAT_IDS`：接收通知的 chat id（支持多个）
- `TARGETS_JSON`：监控目标数组，如：
```json
[
  {"url":"https://example.com/product-a", "titleRegex":"产品A[^<]{0,80}"},
  {"url":"https://example.com/product-b", "titleRegex":"产品B[^<]{0,80}"}
]
```

> 解析逻辑：从 HTML 中按 `库存：<数字>` 正则提取库存，并尽力从附近内容/全局正则/常见容器提取标题。

## 🐳 本地运行（Docker）
```bash
# 克隆仓库并进入
git clone <your repo url> && cd zjmf-monitor

# 将 .env.example 复制为 .env（或直接用 -e 传参）
docker build -t zjmf-monitor:dev .
docker run --rm -it   -e BOT_TOKEN=xxx   -e CHAT_IDS='["123456789","-1001234567890"]'   -e TARGETS_JSON='[{"url":"https://example.com","titleRegex":"标题[^<]{0,80}"}]'   -e PORT=10000   -p 10000:10000   zjmf-monitor:dev
# 访问 http://localhost:10000/healthz 查看健康检查
```

## 🚀 推送 Docker 镜像（GitHub Actions 自动化）
1. 在 **Docker Hub** 新建仓库：`<YOUR_DOCKERHUB_USERNAME>/zjmf-monitor`
2. 在 GitHub 仓库 **Settings → Secrets and variables → Actions** 添加：
   - `DOCKERHUB_USERNAME`（你的 Docker Hub 用户名）
   - `DOCKERHUB_TOKEN`（Docker Hub Access Token）
3. 修改 `.github/workflows/docker.yml` 中镜像地址或直接使用占位 `${{ secrets.DOCKERHUB_USERNAME }}`。
4. 推送到 `main` 或打 tag（如 `v1.0.0`），GitHub Actions 会自动构建并推送多架构镜像到 Docker Hub。

## 🏗️ 在 Render 上部署
### 方式A：使用公开 Docker 镜像（推荐）
1. 在 Render 新建 **Web Service** → **Public Docker image**，填入：
   - `docker.io/<YOUR_DOCKERHUB_USERNAME>/zjmf-monitor:latest`
2. 环境变量：填入 `BOT_TOKEN`、`CHAT_IDS`、`TARGETS_JSON` 等。
3. Health Check Path：`/healthz`
4. Auto deploy：启用（镜像更新后自动发布）。

### 方式B：使用 Blueprint（render.yaml）
- 将仓库连到 Render，使用 `render.yaml`。把 `image:` 行里的用户名替换为你的。
- Render 会按 blueprint 创建服务并使用镜像。

## 🔐 安全注意
- **不要**把 `BOT_TOKEN` 明文提交到仓库。使用 GitHub/Render 的 Secrets。
- 目标站点频率请遵守对方服务条款。必要时调大 `INTERVAL_MS`。

## 🧪 快速排错
- 无消息：确认 `BOT_TOKEN`、`CHAT_IDS` 正确（群组需先让 bot 入群，并授予发送消息权限）。
- 标题为空：调整 `titleRegex`，或改用更靠近“库存”字段的 HTML 容器。
- Render 端口：本应用只有在设置 `PORT` 时才会开启 HTTP（满足健康检查）。

---

MIT © 2025 zjmf-monitor contributors
