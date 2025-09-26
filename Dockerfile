FROM node:20-alpine

WORKDIR /app

# 只拷贝 package.json，避免锁文件要求
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# 应用代码（单文件）
COPY app.js ./

ENV NODE_ENV=production

CMD ["npm", "start"]
