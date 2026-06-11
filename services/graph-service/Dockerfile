# Build context: repo root (not the service directory)
# docker build -f services/graph-service/Dockerfile .

FROM node:22-alpine AS base
RUN npm install -g pnpm@9

# ── Build stage ───────────────────────────────────────────────────────────────
FROM base AS builder
WORKDIR /app

# Copy workspace manifests and lockfile for layer caching
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY services/graph-service/package.json services/graph-service/

RUN pnpm install --frozen-lockfile

COPY services/graph-service/tsconfig.json services/graph-service/
COPY services/graph-service/src services/graph-service/src/

RUN pnpm --filter @liner-notes/graph-service build

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
RUN npm install -g pnpm@9

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY services/graph-service/package.json services/graph-service/

RUN pnpm install --frozen-lockfile --prod --filter @liner-notes/graph-service

COPY --from=builder /app/services/graph-service/dist services/graph-service/dist

ENV NODE_ENV=production
ENV PORT=3000

WORKDIR /app/services/graph-service
EXPOSE 3000

# Drop root: the app binds :3000 (unprivileged) and writes nothing to disk, so the
# stock node user (uid 1000) in the base image is all it needs. Pairs with the
# runAsNonRoot securityContext in infra/k8s/graph-service/deployment.yaml.
#
# NUMERIC on purpose: `USER node` (a name) leaves k8s unable to verify the UID at
# admission, so `runAsNonRoot: true` fails the container with CreateContainerConfigError.
# `node` is uid/gid 1000 in node:22-alpine; spelling it numerically keeps the image and
# the manifest's runAsUser in agreement.
USER 1000:1000

CMD ["node", "dist/index.js"]
