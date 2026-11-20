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

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design, [docs/API.md](docs/API.md) for API
conventions and
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
`apps/api/.env` (`DATABASE_URL`) to something of your own, and replace `JWT_ACCESS_SECRET` and
`OTP_HMAC_SECRET` with values from `openssl rand -base64 48` (they must differ).

Locally, `SMS_PROVIDER=dev` and `EMAIL_PROVIDER=dev` print OTP codes and email links in the API log
instead of sending them. They are refused when `NODE_ENV=production`. The seeded `dev_*` accounts
(for example `dev_asha@example.com`) sign in with the password `voyago-dev-password`.

### Optional providers: add keys, restart, it works

Every provider is chosen by env keys alone. Without keys the feature stays visible in the app with
a short "not set up yet" note (or the API answers 503), and nothing pretends to work. Put the values
in `apps/api/.env` (or the server's secret store), never in git. The API refuses to start when a
chosen provider is missing one of its keys, and says which one.

| Feature                                         | Keys in `apps/api/.env`                                                                                                                                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phone sign-in codes (Twilio)                    | `SMS_PROVIDER=twilio`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and `TWILIO_FROM` or `TWILIO_MESSAGING_SERVICE_SID`                                                                             |
| Phone sign-in codes (MSG91, India DLT)          | `SMS_PROVIDER=msg91`, `MSG91_AUTH_KEY`, `MSG91_TEMPLATE_ID` (an approved OTP flow), `MSG91_OTP_VARIABLE` (default `otp`)                                                                          |
| Email (Resend)                                  | `EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, `EMAIL_FROM` (a verified sender)                                                                                                                       |
| Email (Postmark)                                | `EMAIL_PROVIDER=postmark`, `POSTMARK_SERVER_TOKEN`, `EMAIL_FROM`                                                                                                                                  |
| Google sign-in                                  | `GOOGLE_CLIENT_IDS` (comma separated OAuth client ids), plus the same ids in the app (below)                                                                                                      |
| Apple sign-in (iOS)                             | `APPLE_CLIENT_IDS` with the bundle id `com.voyago.app`                                                                                                                                            |
| Place search, road distance and time            | `GOOGLE_MAPS_API_KEY`: enable **Places API (New)** and **Routes API**, restrict the key to those APIs and your server's IPs                                                                       |
| Push notifications (FCM and APNs, through Expo) | `PUSH_PROVIDER=expo`; optional `EXPO_ACCESS_TOKEN`. In the app's `.env`: `EAS_PROJECT_ID`, and `GOOGLE_SERVICES_FILE` for Android. Upload the APNs key and FCM credentials with `eas credentials` |
| Trip, community, post and chat photos           | `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` (all three); `CLOUDINARY_FOLDER` keeps environments apart                                                                  |

The app reads only public ids, in `apps/mobile/.env`: `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`,
`EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` and `EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID`. The Google button shows
when the API reports Google sign-in on and this platform has a client id. Apple sign-in needs an iOS
development or store build (not Expo Go) with the Sign in with Apple capability.

`GET /api/v1/auth/methods` and `GET /api/v1/features` report which providers are switched on.

## Running

```bash
pnpm dev                                # API on :3000 and admin on :5173
pnpm --filter @voyago/mobile start      # Expo dev server for the mobile app
```

- Health: <http://localhost:3000/api/v1/health/live> (liveness), <http://localhost:3000/api/v1/health/ready> (readiness)
- API docs (OpenAPI): <http://localhost:3000/api/docs>
- Admin: <http://localhost:5173>. Sign in with a staff account. After `pnpm db:seed` locally:
  `dev_admin`, `dev_mod`, `dev_support` or `dev_ops` (`@example.com`, password
  `voyago-dev-password`). In a real environment, create the first super admin with
  `pnpm --filter @voyago/api admin:grant-role --email <email> --role SUPER_ADMIN --reason "<why>"`;
  after that, super admins manage roles in the admin app.

On a physical phone, set `EXPO_PUBLIC_API_BASE_URL` in `apps/mobile/.env` to your computer's LAN IP
(for example `http://192.168.1.20:3000/api/v1`), not `localhost`.

## Checks

```bash
pnpm format:check   # Prettier
pnpm typecheck      # tsc --noEmit, strict, all packages
pnpm lint           # ESLint
pnpm test           # unit tests (API, admin, mobile, shared)
pnpm --filter @voyago/api test:e2e   # API integration + database constraint tests (Docker services)
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
