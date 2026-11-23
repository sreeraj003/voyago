# Deployment

How Voyago is built, configured, released and rolled back. Day-to-day running (monitoring,
backups, incidents) is in `docs/OPERATIONS.md`.

## Environments

| Environment | Purpose                                   | Data                                       | Payments                       |
| ----------- | ----------------------------------------- | ------------------------------------------ | ------------------------------ |
| development | Laptops and CI. `pnpm services:up`        | Seed data (`pnpm db:seed`), never real     | `none`, or Razorpay test keys  |
| staging     | Every release runs here first, same image | Test accounts only; no copies of prod data | Razorpay test keys only        |
| production  | Members                                   | Real                                       | Test keys until legal sign-off |

Settings templates: `apps/api/.env.example` (development), `infra/deploy/staging.env.example` and
`infra/deploy/production.env.example`. The templates hold no secrets. Each key marked `SECRET`
comes from the hosting provider's secret manager and is injected as an environment variable.
The API checks its settings at start-up and refuses to run in production with:

- the dev SMS, email or push providers;
- a CORS origin that is not https;
- Razorpay live keys while `PAYMENTS_LIVE_APPROVED` is not `true`.

## Managed services

| Service        | What to use                                                          | Notes                                                                                                                                                                                 |
| -------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL     | Managed PostgreSQL 16 with the PostGIS 3.5 extension                 | In India (Mumbai or Hyderabad region). TLS required, private network only, point-in-time recovery on. Migrations enable `postgis`, `citext` and `pg_trgm`; the role needs that right. |
| Redis          | Managed Redis 7 (TLS, password)                                      | Rate limits, realtime fan-out, location throttling. Not a store of record: losing it loses no data.                                                                                   |
| Object storage | Cloudinary (already integrated)                                      | Signed uploads only, per-member folders, formats and sizes checked. Separate folder per environment (`CLOUDINARY_FOLDER`).                                                            |
| API hosting    | Any container host (two or more instances behind a load balancer)    | Set `TRUST_PROXY=true` behind the load balancer. WebSockets must be allowed on `/api/v1/realtime`. Sticky sessions are not needed (Redis adapter).                                    |
| Admin hosting  | Any static host with HTTPS (a CDN bucket, Netlify, Cloudflare Pages) | Build with `VITE_API_BASE_URL=https://api.<domain> pnpm --filter @voyago/admin build`, upload `apps/admin/dist`. Add its origin to `CORS_ORIGINS`.                                    |
| Mobile         | Expo EAS Build and Submit                                            | One build profile per environment, each with its own `EXPO_PUBLIC_API_BASE_URL`. No `eas.json` is committed yet; create one with `eas build:configure`.                               |
| Secrets        | The host's secret manager (encrypted at rest, access logged)         | Never in the repository, the image or CI logs. Rotate on staff changes and after any suspected leak.                                                                                  |
| Monitoring     | Prometheus or a hosted equivalent, plus an uptime checker            | `infra/monitoring/`; see `docs/OPERATIONS.md`.                                                                                                                                        |

## The image

`apps/api/Dockerfile`, built from the repository root:

```sh
docker build -f apps/api/Dockerfile --target api -t voyago-api:<git sha> .
docker build -f apps/api/Dockerfile --target migrate -t voyago-api-migrate:<git sha> .
```

- `api`: production dependencies and the compiled server only, running as the unprivileged
  `node` user, with a liveness health check. About 875 MB unpacked, most of it the Prisma
  engines.
- `migrate`: runs `prisma migrate deploy` and exits.
- No secrets or `.env` files are copied in (`.dockerignore`).

CI builds both images on every push and checks that the API image runs as a non-root user and
answers `/health/live`. Nothing is pushed from CI.

## Releasing

1. Merge to `main` with CI green.
2. Build both images tagged with the commit sha and push them to the registry.
3. **Staging:** take a backup if the release has a migration (`scripts/backup.sh`), run the
   `migrate` image once, then roll the `api` image out. Check `/health/ready`, admin **System**,
   sign in on the staging app, and run the smoke list below.
4. **Production:** the same steps with the same image tags. Always take a backup first when the
   release has a migration. Roll out one instance at a time, so a failing instance stops the
   rollout before every instance runs it.
5. Watch the error rate and p95 latency on admin **System** for 30 minutes.

Smoke list: sign in, open Explore (near me and search), open a trip, send a chat message, start
and stop location sharing on a test trip, open the admin dashboard.

Migrations must be backward compatible with the previous release: add columns and tables
first, ship the code that uses them, and remove old columns in a later release. This is what
makes rolling back the image safe.

## Rolling back

- **Bad code, no migration:** redeploy the previous image tag. Nothing else is needed.
- **Bad code with an additive migration:** redeploy the previous image. The old code ignores the
  new columns. Fix forward with a new migration if the new columns need to go.
- **A migration failed part-way:** the API refuses to start against a failed migration. Read the
  error, then mark it rolled back with `prisma migrate resolve --rolled-back <name>` after checking
  its changes are not present, fix it, and release again. Never edit production data by hand.
- **Data damaged by a release:** restore from the backup taken before the release, following
  "Real restore" in `docs/OPERATIONS.md`, then reconcile payments.

Rolling back the mobile app is not possible once installed. Keep the API backward compatible with
the previous app versions still in use. There is no forced-update check in the app yet, so a
breaking API change needs a new versioned path (`/api/v2`).

## Database settings

- `DATABASE_SESSION_OPTIONS` defaults to `-c jit=off`. The load test showed JIT compilation adding
  40 ms or more to short queries. Set it to empty when a connection pooler (such as PgBouncer in
  transaction mode) rejects startup options, and turn JIT off on the server instead.
- Pool size: the pg default (10 per instance). Keep instances × 10 under the database's
  connection limit, or put a pooler in front.

## Performance baseline (milestone 16)

`scripts/perf/seed-volume.sql` loads 20,000 members and 50,000 published trips (70% around
Bengaluru) into a scratch database. `scripts/perf/load-test.mjs` and
`scripts/perf/socket-load.mjs` load an API pointed at it. Measured on one 4-core machine running
the API, PostgreSQL, Redis and the load generator together, 20 concurrent clients:

| Endpoint                       | Before (p50, single request) | After (p50 single) | After (20 concurrent: req/s, p95) |
| ------------------------------ | ---------------------------- | ------------------ | --------------------------------- |
| Search near a point, relevance | 24 s                         | 0.1 s              | 38/s, 0.74 s                      |
| Nearby, 25 km                  | 0.19 s                       | 0.07 s             | 40/s, 0.70 s                      |
| Trending                       | 0.75 s                       | 0.1 s              | 16/s, 1.9 s                       |
| Search by text                 | 40 ms                        | n/a                | 516/s, 59 ms                      |
| Trip detail                    | n/a                          | n/a                | 248/s, 119 ms                     |
| Feed                           | n/a                          | n/a                | 307/s, 88 ms                      |
| Me                             | n/a                          | n/a                | 670/s, 49 ms                      |
| Readiness probe                | n/a                          | n/a                | 1,455/s, 25 ms                    |

1,000 realtime connections opened in 1.3 s (p95 connect 140 ms) with no failures; the API used
about 270 MB of memory.

The search near a point was slow because the filters compared enums as text, which hid the
column statistics from the planner. It then estimated one row and chose a plan that read the
users table once per trip. Fixes: compare enums directly, keep a stored participant count on
each trip (database trigger), hash the member's block list once per query, count this week's
joins once for trending, and turn JIT off. The data set is far denser than a beta (35,000 open
trips within 25 km of one point), so these numbers are a ceiling test, not a forecast.
