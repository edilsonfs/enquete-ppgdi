FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY public ./public

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/app/data

RUN mkdir -p /app/data
EXPOSE 8080

# 127.0.0.1, nunca localhost: em Alpine o localhost resolve para ::1 antes do
# IPv4, o healthcheck falha, o container recicla e o Traefik devolve 502 eterno.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
