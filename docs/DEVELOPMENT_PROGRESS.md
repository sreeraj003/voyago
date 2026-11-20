# Development progress

Milestones follow the development pack (`00_START_HERE.md`). Each milestone is completed and
verified before the next starts.

| #   | Milestone                                   | Status      |
| --- | ------------------------------------------- | ----------- |
| 01  | Project foundation and architecture         | Done        |
| 02  | Database design and migrations              | Done        |
| 03  | Backend foundation and API conventions      | Done        |
| 04  | Authentication and user profiles            | Done        |
| 05  | Trip creation and lifecycle                 | Done        |
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

## Milestone 05: Trip creation and lifecycle (2026-11-20)

### Implemented

- **Trip engine** (`apps/api/src/trips`): create (draft, organiser added as first participant),
  view, edit, delete draft, publish, start, complete, cancel, and "my trips" with cursor
  pagination. Both modes share one model; Ride is always a motorcycle ride.
- **Lifecycle** in `@voyago/shared` (`TRIP_TRANSITIONS`, `canTransition`) and enforced only by the
  API with conditional updates (a concurrent change returns 409). `FULL` follows capacity
  (`syncCapacityStatus`, reused by joining in milestone 07). An expiry job marks published trips
  that never started as `EXPIRED` 24 hours after departure.
- **Validation:** shared `tripRuleIssues` / `departureIssue` (dates, capacity, mode vs activity,
  engine size, stop times) used by the app for instant feedback and by the API after merging edits.
- **Locking:** mode/activity fixed after publishing; only the description after start; nothing
  after the trip ends.
- **Access and privacy:** drafts organiser-only, private trips participants-only, blocks hide trips
  both ways, exact meeting point only for participants (others get it rounded to about 1 km).
- **Moderation:** moderators and admins can view and cancel any trip; each moderator cancel writes
  an `audit_logs` row with the request id.
- **Free vs commercial:** the API only creates `COMMUNITY_FREE` trips and ignores client-sent
  `tripType`/`status`/`organiserId`; commercial departures cannot be changed through these routes.
  No payment, seat sales or driver matching.
- **Honest estimates:** distance and duration are labelled as the organiser's estimates; no route
  is computed. Budget is a per-person cost-sharing estimate.
- **Mobile:** Create tab lists your trips; a 4-step create flow (mode and details → route, dates and
  stops editor → group settings → preview); trip detail with status and the actions the API
  allows (publish, start, complete, edit, cancel with reason, delete draft); edit reuses the flow
  and sends only changed fields, or only the description once the trip has started.

### Database changes

Migration `20261120090000_trip_lifecycle`; see `docs/DATABASE.md`.

### APIs

9 trip routes; see `docs/API.md` → Trips.

### Tests

- API e2e: 88 total (14 new in `trips.e2e-spec.ts`): ownership, invalid dates and capacity,
  mode/activity, coordinates, stop times, invalid transitions, publish with past departure,
  editing after start, mode lock, capacity vs participants, FULL ⇄ PUBLISHED, drafts and private
  access, approximate origin, blocks, moderator cancel with audit row, expiry job, commercial
  separation (seeded commercial departure), my-trips pagination.
- Unit: lifecycle table and rules (shared), access and allowed actions (API), form parsing and
  error mapping (mobile).
- Manual: Expo web against the live API: create a ride with a stop, publish, edit, cancel, list.

### Outstanding

- **Cover images** need object storage (signed uploads); the field is returned as `null`.
- **Places** are typed as name plus coordinates. A map picker and geocoding need a maps provider
  (for example Google Maps or Mapbox) and an API key. Dates are typed (`YYYY-MM-DD HH:MM`, device
  time zone) until a native date picker is added.
- Route distance and duration from a routing provider (labelled estimates until then).
- The expiry job runs in-process every 15 minutes; a job runner arrives in milestone 15.
- Discovery of public trips is milestone 06; joining is milestone 07.

---

## Milestone 04: Authentication, accounts and profiles (2026-11-20)

Sign-in methods chosen for launch: **phone OTP and email + password**. Google and Apple adapters
are built and switch on when their client ids are configured; until then they return 503.

### Implemented

- **Email + password:** register, login, change password, forgot / reset password, email
  verification links. Argon2id (19 MiB, t=2, p=1). A dummy hash is checked when no account
  matches, so timing does not reveal accounts.
- **Phone OTP:** 6-digit codes from `crypto.randomInt`, stored as HMAC-SHA-256, valid 5 minutes,
  5 attempts, single use, a new code replaces the old one. Limits: 3 codes per number per 15
  minutes and 10 per day, plus the per-IP route limit. New numbers get a 15-minute signup token
  and choose a username (`/auth/signup/complete`).
- **Google / Apple:** ID tokens verified against the providers' JWKS (issuer, audience = configured
  client ids, signature). Linked by `(provider, subject)`. Auto-linking to an existing account
  only when both the provider and Voyago have verified the same email.
- **Sessions:** 15-minute HS256 access tokens (`sub`, `sid` = session family). Opaque 256-bit
  refresh tokens stored as SHA-256, valid 30 days, rotated on every refresh. Reusing a rotated
  token revokes the whole family. Logout revokes this device's family, logout-all every session,
  password change signs out other devices, password reset signs out all. The guard checks the
  session and account status on every request, so logout and suspension apply immediately.
- **Account enumeration:** register and forgot-password return the same 202 whether or not the
  email exists (the real owner gets an email instead); login returns one generic 401; OTP request
  is always 202. Only a taken _username_ returns 409, because usernames are public.
- **Rate limits:** `AUTH_RATE_LIMIT_MAX` (default 10) requests per minute per IP on each sign-in,
  OTP and recovery route; 10 failed passwords per account lock it for 15 minutes (Redis).
- **Providers:** `SMS_PROVIDER` and `EMAIL_PROVIDER` are `none` or `dev`. `none` makes phone sign-in
  and email-dependent routes return 503 rather than pretend. `dev` logs messages locally and is
  rejected by env validation and by the adapter constructor when `NODE_ENV=production`. Real
  providers are added when credentials exist.
- **Profiles:** `GET/PATCH /me` (name, username, bio, city, country, languages),
  `GET/PATCH /me/preferences` (mode, interests, activities, travel styles, destinations, budget
  range, group size, riding experience, visibility, messaging and notification settings),
  `/me/motorcycles` CRUD (make, model, year, cc, category, nickname, primary; no registration
  numbers or documents), `GET /users/:username` public profile.
- **Privacy:** public profiles never include email, phone, role, status or bike nicknames. Blocks in
  either direction and inactive accounts return 404. `PRIVATE` profiles, and `FOLLOWERS` profiles
  seen by non-followers, show only name, username and verification badges.
- **Mobile:** sign-in, register, phone OTP (with username step), forgot password, reset-password and
  verify-email link screens, and a Profile tab with edit form, visibility setting, resend
  verification and sign-out. Refresh token in the Keychain / Keystore (`expo-secure-store`),
  access token in memory, single-flight refresh on 401. Tabs require sign-in.
- **Seed:** `dev_*` accounts can sign in with `voyago-dev-password`.

### Database changes

Migration `20261120072947_auth_and_profiles`; see `docs/DATABASE.md`.

### APIs

See the endpoint table in `docs/API.md`: 15 `/auth/*` routes, 8 `/me*` routes, `GET /users/:username`.

### Tests

- API e2e (real Postgres/PostGIS and Redis): 74 tests, 28 new in `auth.e2e-spec.ts` and
  `users.e2e-spec.ts`: registration, enumeration safety, login lockout, refresh rotation and reuse
  detection, logout / logout-all, tampered tokens, suspended accounts, email verification,
  password reset and change, OTP signup / sign-in / attempt and per-number limits, providers
  disabled, auth rate limit, profile updates ignoring protected fields, public profile privacy
  (no contact details, visibility, blocks), preferences ranges, motorcycle ownership.
- API unit: argon2id, token signing and purpose separation, `alg=none` rejection, social token
  verification with a local JWKS, production refusal of dev adapters, env rules.
- Shared: schema normalisation and validation. Mobile: refresh-and-retry, sign-out on rejected
  refresh, field errors, sign-in screen.
- Manual: Expo web against the live API: sign in (wrong then right password), edit profile,
  reload restores the session, sign out, phone code request.

### Outstanding

- **Real SMS and email providers** need accounts and credentials (for example MSG91 or Twilio for
  SMS with DLT registration in India, and SES or Postmark for email). Until then production runs
  with `none`: email/password works, but phone sign-in, verification and reset emails return 503.
- **Google / Apple** need OAuth client ids and the native sign-in SDKs in the app (the API side is
  ready). Apple also requires "Sign in with Apple" whenever another social login is offered on iOS.
- **Profile photos** wait for object storage (signed uploads), planned with media in a later milestone.
- **Account deletion and data export** are planned for milestone 16 (privacy and launch readiness).
- Sliding 30-day refresh sessions have no absolute maximum yet; expired rows are not yet cleaned up.
- The web build stores the refresh token in localStorage; a production web client should use an
  httpOnly cookie.

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
