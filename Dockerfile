FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
# Pakai npm ci bila package-lock.json ada; jika tidak, npm install biasa.
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev --no-audit --no-fund; fi
COPY src ./src
COPY public ./public
COPY docs/schema.graphql ./docs/schema.graphql
USER node
# Satu image untuk semua service; service dipilih lewat command (lihat docker-compose.yml)
CMD ["node", "src/gateway.js"]
