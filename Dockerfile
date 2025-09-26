FROM node:20-alpine

WORKDIR /app

# 先复制依赖清单以利用缓存
COPY package*.json ./

# 有 lock 用 ci；没 lock 用 install（更稳）
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev --no-audit --no-fund; \
    else \
      npm install --omit=dev --no-audit --no-fund; \
    fi

# 再复制其余代码（包含 src/app.mjs）
COPY . .

ENV NODE_ENV=production

CMD ["npm", "start"]
