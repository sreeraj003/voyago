# Voyago

Social riding and travel platform: find people to ride or travel with, create trips, join trips and
build communities. Two modes share one platform: **Ride** (motorcycle group rides) and **Travel**
(road trips, backpacking, group travel). Initial market: Bengaluru, India.

This repository is a TypeScript monorepo:

| Path              | Description                                             |
| ----------------- | ------------------------------------------------------- |
| `apps/api`        | NestJS backend (modular monolith), REST under `/api/v1` |
| `apps/mobile`     | React Native app (Expo + Expo Router)                   |
| `apps/admin`      | React admin dashboard (Vite)                            |
| `packages/shared` | Shared Zod schemas and TypeScript types                 |
| `infra/docker`    | Docker Compose for local PostgreSQL/PostGIS and Redis   |
| `docs`            | Architecture, decisions (ADRs) and development progress |
| `project-specs`   | Product brief and milestone specifications (00 to 16)   |

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design and
[docs/DEVELOPMENT_PROGRESS.md](docs/DEVELOPMENT_PROGRESS.md) for status.

## Prerequisites

- Node.js 22 LTS (`nvm use` reads `.nvmrc`)
- pnpm 10 (`corepack enable` picks up the pinned version)
- Docker with Docker Compose v2
- For the mobile app: the Expo Go app on a phone, or an Android emulator / iOS simulator

## Setup from a fresh clone

```bash
git clone https://github.com/sreeraj003/voyago.git
cd voyago
corepack enable
pnpm install

# Environment files (placeholders only; never commit the real ones)
cp infra/docker/.env.example infra/docker/.env
cp apps/api/.env.example apps/api/.env
cp apps/admin/.env.example apps/admin/.env.local
cp apps/mobile/.env.example apps/mobile/.env

# Start PostgreSQL/PostGIS and Redis, then apply migrations
pnpm services:up
pnpm db:migrate
pnpm db:seed        # optional: development-only sample data
```

Change `POSTGRES_PASSWORD` in `infra/docker/.env` and the matching password in
`apps/api/.env` (`DATABASE_URL`) to something of your own.

## Running

```bash
pnpm dev                                # API on :3000 and admin on :5173
pnpm --filter @voyago/mobile start      # Expo dev server for the mobile app
```

- Health check: <http://localhost:3000/api/v1/health>
- API docs (OpenAPI): <http://localhost:3000/api/docs>
- Admin: <http://localhost:5173>

On a physical phone, set `EXPO_PUBLIC_API_BASE_URL` in `apps/mobile/.env` to your computer's LAN IP
(for example `http://192.168.1.20:3000/api/v1`), not `localhost`.

## Checks

```bash
pnpm format:check   # Prettier
pnpm typecheck      # tsc --noEmit, strict, all packages
pnpm lint           # ESLint
pnpm test           # unit tests (API, admin, mobile, shared)
pnpm --filter @voyago/api test:e2e   # API smoke + database constraint tests (Docker services)
pnpm check          # format + typecheck + lint + unit tests
```

CI (`.github/workflows/ci.yml`) runs all of these on every push to `main` and on pull requests,
with real PostgreSQL/PostGIS and Redis service containers.

## Database

See [docs/DATABASE.md](docs/DATABASE.md) for the schema, ER diagram and constraint rationale.

```bash
pnpm db:migrate     # apply pending migrations
pnpm db:seed        # load development-only sample data (idempotent; refuses production)
pnpm db:reset       # DEV ONLY: drop the local database, re-apply migrations, re-seed
pnpm --filter @voyago/api prisma:migrate:dev -- --name <change>   # create a migration from schema changes
pnpm --filter @voyago/api prisma:studio     # browse the database
```

## Useful commands

```bash
pnpm services:down                          # stop Docker services (data is kept in volumes)
pnpm --filter @voyago/mobile doctor         # check Expo package versions
```

## Rules

- Secrets never go in Git. Only `.env.example` files with placeholders are committed.
- Every database change is a Prisma migration.
- Contact details and exact locations are never exposed publicly. Safety, blocking and reporting
  stay free.
- No paid passenger transport, driver matching or ride-hailing without legal review.
