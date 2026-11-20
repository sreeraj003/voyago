# Development progress

Milestones follow the development pack (`00_START_HERE.md`). Each milestone is completed and
verified before the next starts.

| #   | Milestone                                   | Status      |
| --- | ------------------------------------------- | ----------- |
| 01  | Project foundation and architecture         | Done        |
| 02  | Database design and migrations              | Not started |
| 03  | Backend foundation and API conventions      | Not started |
| 04  | Authentication and user profiles            | Not started |
| 05  | Trip creation and lifecycle                 | Not started |
| 06  | Discovery and geospatial search             | Not started |
| 07  | Join requests and participant management    | Not started |
| 08  | Communities and social graph                | Not started |
| 09  | Chat and notifications                      | Not started |
| 10  | Admin dashboard and moderation              | Not started |
| 11  | Live location and safety workflows          | Not started |
| 12  | Commercial operators and packages           | Not started |
| 13  | Bookings, payments, commissions and refunds | Not started |
| 14  | Subscriptions and monetisation              | Not started |
| 15  | Analytics, observability and operations     | Not started |
| 16  | Security, testing, launch readiness, deploy | Not started |

---

## Milestone 02: Database design and migrations (2026-11-20)

### Implemented

- Prisma schema for all 24 entities in the spec, plus `user_blocks` (free core safety feature):
  users, preferences, motorcycles, trips, stops, participants, join requests, communities,
  members, follows, conversations, members, messages, notifications, reviews, reports, commercial
  operators and packages, bookings, payments, subscription plans, subscriptions, location sessions,
  audit logs. 37 Postgres enums for lifecycle states.
- PostGIS `geography(Point, 4326)` columns for trip origin/destination, stops and package
  destinations, with GiST indexes, plus parameterised SQL helpers (`src/infra/prisma/geo.ts`).
- Hand-written CHECK constraints, partial unique indexes and triggers for rules Prisma cannot express,
  including the separation of free community trips from commercial bookings, verified-operator
  publishing, 24-hour live location limit, money sanity and an append-only audit log.
- Idempotent, development-only seed (`prisma/seed.ts`) that refuses production and remote databases.
- `docs/DATABASE.md`: ER diagram, conventions, constraint, delete-behaviour and index rationale,
  deferred entities. README gained `db:seed` and `db:reset`.

### Database changes

- Migration `20261120070747_initial_schema`: enables `citext`; creates 24 tables, enums, indexes,
  constraints and triggers. Verified with `prisma migrate diff`: no drift between schema and database.

### APIs

None (this milestone is schema only). `GET /api/v1/health` unchanged.

### Commands run and results

| Command                                                    | Result                                                                                                                                                                                                                                            |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm db:migrate` on a clean database                      | Both migrations applied                                                                                                                                                                                                                           |
| `prisma migrate diff --from-config-datasource --to-schema` | Empty: no drift                                                                                                                                                                                                                                   |
| `pnpm db:seed` twice                                       | Succeeded; second run changed nothing                                                                                                                                                                                                             |
| `NODE_ENV=production pnpm db:seed` / remote `DATABASE_URL` | Refused, as intended                                                                                                                                                                                                                              |
| `pnpm db:reset`                                            | Not run by the agent: Prisma blocks AI agents from resetting databases without explicit user consent. The production guard was verified (`NODE_ENV=production` refused); clean-database migration was verified with fresh Docker volumes instead. |
| `pnpm format:check`, `pnpm typecheck`, `pnpm lint`         | Passed                                                                                                                                                                                                                                            |
| `pnpm test`                                                | Unit tests passed (API 16, admin 6, mobile 5, shared 3)                                                                                                                                                                                           |
| `pnpm --filter @voyago/api test:e2e`                       | 31 passed: 27 database constraint/PostGIS tests + 4 API smoke tests                                                                                                                                                                               |

### Outstanding

- Text search indexes (`pg_trgm`) are deferred to milestone 06; auth session tables to milestone 04.
  Full list in `docs/DATABASE.md` → Deferred.
- Money columns are `int4` paise (max about ₹2.1 crore per row). Switch to `bigint` if a single
  booking could ever exceed that.

---

## Milestone 01: Project foundation and architecture (2026-11-20)

### Implemented

- pnpm + Turborepo monorepo: `apps/api`, `apps/mobile`, `apps/admin`, `packages/shared`, `infra`,
  `docs`.
- **API (NestJS 12):** Zod-validated environment (fails fast at startup), Pino structured logging
  with request ids and redaction, one error response shape, Helmet, CORS allowlist, global rate
  limit, OpenAPI docs at `/api/docs`, Prisma 7 with the PostGIS migration, Redis client, and
  `GET /api/v1/health` checking Postgres, PostGIS and Redis.
- **Shared package:** `ApiError`, `HealthResponse` and `TripMode` Zod schemas.
- **Mobile (Expo SDK 58):** Expo Router with Home / Explore / Create / Inbox / Profile tabs, Ride /
  Travel selector (Zustand), "Find a Ride" / "Find Travel Buddies" / "Create a Trip" actions,
  light/dark tokens, server status on Profile. Other screens say plainly which milestone builds them.
- **Admin (React + Vite):** responsive shell with live API health.
- Docker Compose for PostgreSQL 16 + PostGIS 3.5 and Redis 7.4.
- Prettier, ESLint (type-aware), strict TypeScript everywhere, GitHub Actions CI.
- Docs: README, `docs/ARCHITECTURE.md` (diagram), ADRs 0001 to 0006, this file.

### Database changes

- Migration `20261120000000_enable_postgis`: `CREATE EXTENSION IF NOT EXISTS postgis`. No tables
  yet (milestone 02).

### APIs

| Method | Path             | Description                                                   |
| ------ | ---------------- | ------------------------------------------------------------- |
| GET    | `/api/v1/health` | 200 + status when Postgres, PostGIS, Redis are up; 503 if not |
| GET    | `/api/docs`      | OpenAPI UI (`/api/docs-json` for the JSON document)           |

### Tests

| Package          | Tests                                                                 |
| ---------------- | --------------------------------------------------------------------- |
| `@voyago/api`    | Env validation, error filter, Zod pipe, health aggregation (unit)     |
| `@voyago/api`    | Smoke test: boots the app against real Postgres/PostGIS + Redis (e2e) |
| `@voyago/admin`  | API client, routing                                                   |
| `@voyago/mobile` | Mode store, Ride/Travel selector, API client                          |
| `@voyago/shared` | Schema validation                                                     |

### Verification (completion gate)

Run from a fresh clone with empty Docker volumes on 2026-11-20:

- `pnpm install --frozen-lockfile`, `pnpm services:up`, `pnpm db:migrate`: passed.
- `pnpm format:check`, `pnpm typecheck`, `pnpm lint`, `pnpm build`: passed.
- `pnpm test`: 27 unit tests passed (API 13, admin 6, mobile 5, shared 3).
- `pnpm --filter @voyago/api test:e2e`: 4 smoke tests passed against real Postgres/PostGIS + Redis.
- Started the built API: `/api/v1/health` returned `ok` with all three dependencies `up`.
- Started the API with a missing `DATABASE_URL`: it exited with code 1 and a readable error.
- Exported the mobile app for web and loaded it in Chromium: Home, Ride/Travel selector and tabs
  render with no runtime errors. (Wrapping a `Pressable` in `<Link asChild>` crashed on web with
  Expo SDK 58, so Home navigates with `router.navigate` instead.)
- Not verified here: the native iOS/Android builds (needs a device or simulator) and CI on GitHub
  (runs on the first push).

### Open decisions

- Map provider (Google Maps, Mapbox, or MapLibre + OSM tiles).
- Sign-in method for milestone 04 (phone OTP needs an SMS provider; or email + Google/Apple).
- Hosting target for deployment (decided by milestone 16).
- Socket.IO gateway is deferred to milestone 09 (chat), when it has an authenticated use.
