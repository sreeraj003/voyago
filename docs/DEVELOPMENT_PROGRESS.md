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
