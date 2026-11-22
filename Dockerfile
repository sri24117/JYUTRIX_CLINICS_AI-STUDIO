# Jyutrix Clinic Reception: Node + tsx, deployed with Coolify (see compose.coolify.yaml)
FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production

# Install runtime dependencies first so this layer is cached between code changes.
# tsx and typescript are in "dependencies", so --omit=dev is safe (jsdom is test-only).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

COPY --chown=node:node . .

USER node
EXPOSE 3000

CMD ["node_modules/.bin/tsx", "server.ts"]
