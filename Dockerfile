# Dockerfile
FROM node:20-alpine

WORKDIR /app

# Copy manifests first for better layer caching
COPY package.json package-lock.json* ./

# Install production deps; fall back to npm install if no lockfile
RUN if [ -f package-lock.json ]; then       npm ci --omit=dev --no-audit --no-fund;     else       npm install --omit=dev --no-audit --no-fund;     fi

# Copy source
COPY src ./src

ENV NODE_ENV=production

# Render will inject PORT. If set, app exposes /healthz
ENV PORT=0

CMD ["npm", "start"]
