FROM node:22-alpine AS base
RUN npm install -g pnpm

# ── Build stage ──────────────────────────────────────────────────────────────
FROM base AS builder
WORKDIR /app

COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src/ ./src/
RUN pnpm build

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
RUN npm install -g pnpm

WORKDIR /app

COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "dist/index.js"]
