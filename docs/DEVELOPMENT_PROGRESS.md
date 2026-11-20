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

## Milestone 03: Backend foundation and API conventions (2026-11-20)

Milestone 01 already delivered the `/api/v1` prefix, env validation, structured logging with
request ids, Helmet, CORS from env, a global rate limit, Swagger and Prisma/Redis clients. This
milestone completed the rest of the spec.

### Implemented

- **Global validation:** `createZodDto` turns `@voyago/shared` Zod schemas into DTO classes; a global
  `ZodValidationPipe` validates every DTO-typed body, query and path parameter, strips unknown fields,
  and the same schema documents the DTO in Swagger. UUID path parameters are validated.
- **Response conventions:** `{ data }` / `{ data, page }` envelopes, cursor pagination
  (`CursorPageQuerySchema`, `decodeCursor`, `toPage`), all in shared code. Documented in `docs/API.md`.
- **Error handling:** database errors map to safe statuses (409 duplicate or related-record
  conflict, 404 not found, 422 data rule, generic 500 otherwise) with no SQL, table or constraint
  names in responses; malformed JSON → 400; bodies over 100 KB → 413.
- **Request ids** are assigned before body parsing, so every response, including body errors,
  carries one.
- **Health:** `/health/live` (process only) and `/health/ready` (PostgreSQL, PostGIS, Redis; 503 when
  any is down). `/health` stays as an alias for the apps.
- **Resilient startup:** the API starts even when PostgreSQL or Redis is down; readiness reports it,
  Redis reconnects with capped backoff and fails fast while disconnected.
- **Auth guard foundation:** global `AuthGuard`, secure by default. Every route returns 401 unless
  marked `@Public()`. No sign-in behaviour is invented; milestone 04 plugs in token verification.
- `TRUST_PROXY` setting so rate limits use the real client IP behind a load balancer.
- Code reorganised by the spec's module names: `common`, `config`, `database`, `redis`, `health`.
  Empty placeholder modules were deliberately not created.

### Database changes

None.

### APIs

| Method | Path                   | Description                                    |
| ------ | ---------------------- | ---------------------------------------------- |
| GET    | `/api/v1/health/live`  | Liveness (new)                                 |
| GET    | `/api/v1/health/ready` | Readiness, 503 when a dependency is down (new) |
| GET    | `/api/v1/health`       | Alias of readiness (unchanged contract)        |

### Tests

`test/api-foundation.e2e-spec.ts` boots the real app (with test-only routes) against PostgreSQL and
Redis and checks: liveness and readiness, body/query/UUID validation with field details, unknown
fields stripped, malformed JSON 400, oversized body 413, duplicate 409 and CHECK-rule 422 without
leaking database names, 404 shape, 401 from the auth guard, cursor pagination across real rows,
Swagger paths and DTO schemas, 429 after the rate limit (health exempt), and startup with both
PostgreSQL and Redis unreachable (live 200, ready 503).

| Command                                                          | Result                                                  |
| ---------------------------------------------------------------- | ------------------------------------------------------- |
| `pnpm format:check`, `pnpm typecheck`, `pnpm lint`, `pnpm build` | Passed                                                  |
| `pnpm test`                                                      | Unit tests passed (API 29, admin 6, mobile 5, shared 5) |
| `pnpm --filter @voyago/api test:e2e`                             | 46 passed (15 API foundation, 27 database, 4 smoke)     |

### Outstanding

- Authentication itself (milestone 04) replaces the guard's "always 401" branch.
- Socket.IO gateway is still deferred to milestone 09 (chat).

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
