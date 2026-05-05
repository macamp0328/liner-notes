# graph-service

The core backend service for liner-notes. A Fastify REST API that ingests a Discogs vinyl collection into Neo4j and exposes endpoints for graph-based exploration.

## Local Development

```bash
# From repo root
cp .env.example .env.local   # fill in values
docker-compose up             # starts Neo4j + this service

# Or run without Docker
cd services/graph-service
cp .env.example .env.local
pnpm install
pnpm dev
```

## API

- **Health:** `GET http://localhost:3000/api/v1/health`
- **Docs:** `GET http://localhost:3000/api/docs` (Swagger UI)
- See [CLAUDE.md](CLAUDE.md) for full endpoint reference

## Build

```bash
pnpm build         # compile TypeScript → dist/
pnpm typecheck     # type check only, no output
pnpm test          # run Vitest test suite
pnpm lint          # ESLint
```

## Docker

```bash
docker build -t liner-notes/graph-service .
docker run -p 3000:3000 --env-file .env.local liner-notes/graph-service
```
