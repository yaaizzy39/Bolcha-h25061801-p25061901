# ---- Build Stage ----
FROM node:20 AS builder

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

# 必要に応じてクライアントビルド（Vite/React想定）
RUN npm run build || true

# ---- Production Stage ----
FROM node:20-slim

WORKDIR /app

COPY --from=builder /app .

#Googleログインが出来ない為、とりあえずコメントアウトした（25/6/19）
#ENV NODE_ENV=production

# 5000番ポートでExpressなどが起動する想定
EXPOSE 5000

CMD ["npm", "start"]
