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
| 06  | Discovery and geospatial search             | Done        |
| 07  | Join requests and participant management    | Done        |
| 08  | Communities and social graph                | Done        |
| 09  | Chat and notifications                      | Not started |
| 10  | Admin dashboard and moderation              | Not started |
| 11  | Live location and safety workflows          | Not started |
| 12  | Commercial operators and packages           | Not started |
| 13  | Bookings, payments, commissions and refunds | Not started |
| 14  | Subscriptions and monetisation              | Not started |
| 15  | Analytics, observability and operations     | Not started |
| 16  | Security, testing, launch readiness, deploy | Not started |

---

## Milestone 08: Communities and social graph (2026-11-20)

Also completes the milestone 07 follow-ups: co-organisers and invitations to private trips.

### Implemented

- **Co-organisers** (`apps/api/src/participation`): the organiser promotes a participant (and
  can demote them). Co-organisers review join requests, invite people and remove participants
  (audit logged), but cannot remove each other, edit, publish, start, complete or cancel.
- **Trip invitations:** organisers and co-organisers invite by username. Invitees can see a
  private trip and join it by accepting (same locked capacity check as approvals); on other
  trips an invitation skips approval. Decline and revoke; open invitations are withdrawn when the
  trip is cancelled, started or expires, or when either person blocks the other. Private trips
  can no longer be joined by request.
- **Communities** (`apps/api/src/communities`): create (creator is owner), edit (admins), delete
  (owner), search and list (`q`, mode, category, city, mine), join open communities, ask to join
  approval communities with a note, cancel, leave (not the owner), approve and decline requests,
  ranked roles (owner, admin, moderator, member) where nobody can act on their own rank or above,
  remove and ban with a reason, lift bans, member lists, community trips (upcoming and past),
  community posts and announcements with member notifications. Every moderator action is audit
  logged. Private communities show only their card to non-members.
- **Community trips:** trips can be posted in a community you belong to, with the new
  `COMMUNITY` visibility (members only). They stay out of public discovery.
- **Social graph** (`apps/api/src/social`): follow and unfollow (with a notification), follower
  and following lists that respect profile visibility, follow state on public profiles (mutual
  and "follows you" only where the profile is visible), block and unblock (removes follows both
  ways and open invitations; blocked people disappear from profiles, trips, lists and the feed),
  my blocked list, and reports of members, trips, communities and posts (repeats merged).
- **Posts and feed** (`apps/api/src/posts`): trip recaps (completed trips you were on),
  destination photos (1–6 Cloudinary photos, kind `post-photo`), community announcements, and
  deletion by the author or community moderators and staff (audited). `GET /feed` is a plain
  reverse-chronological mix of posts and newly published trips from people you follow, your own,
  and your communities, with no ranking.
- **Uploads:** `POST /uploads/signature` signs uploads by kind (trip cover, community cover, post
  photo); each kind has its own folder per member.
- **Mobile:** Explore has a Trips / Communities switch with community search, "Mine" and "Start
  a community". New screens: community detail (join state, members, edit, announcements, upcoming
  and past trips, posts, report), members and requests with approve, decline, roles, remove and
  ban, create and edit community, public profiles with follow, block and report, blocked people,
  new post (recap or photos), and trip invitations. The trip page gains co-organiser controls,
  "Invite people", accept/decline for invitees, links to the organiser and community, "Share a
  trip recap" and "Report trip"; the people screen can make co-organisers. Home shows the feed;
  the Inbox shows pending invitations and opens followers and communities from notifications.
  "Plan a trip for this community" creates a members-only trip.

### Database changes

Migration `20261120130000_communities_social`; see `docs/DATABASE.md`.

### Tests

- 32 new end-to-end tests (150 in total): co-organiser appointment and limits; invitations to
  private trips (visibility, accept, decline, revoke, blocks, capacity, cancellation); community
  creation, open and approval joining, private content access, leaving; role ranking (nobody
  raises their own privileges), removal, bans and lifting them, audit records; announcements,
  members-only posts, moderator deletion; community trip visibility and membership checks;
  follows, mutual state, private follower lists; blocks hiding everything both ways; reports;
  recap rules; feed visibility (followers-only posts, private community posts, blocks) and paging
  without repeats.
- API unit tests for co-organiser, invitation and community-trip visibility rules; mobile unit
  tests for the community trip form and community addresses (35 mobile tests).
- Browser check on Expo web against the real API: feed, joining a community, members list,
  following, an owner's announcement and member list, inviting to a trip, accepting from the
  Inbox, and the announcement in the member's feed. No errors.

### Outstanding

- Push and email notifications arrive with milestone 09 and need provider credentials.
- Photo posts and community covers need the Cloudinary keys in the server environment; without
  them the API returns 503 and the app hides photo options.
- Reports are stored for the moderation queue; the admin tools that work through them are
  milestone 10.
- Ownership transfer is not built yet; an owner can delete the community instead of leaving.
- Communities are found by name, description and city; nearby (map) search for communities is
  not built.

---

## Milestone 07: Join requests and participant management (2026-11-20)

### Implemented

- **Join flow** (`apps/api/src/participation`): ask to join (with an optional note), approve,
  decline with an optional reason, withdraw, list a trip's requests and my own, list participants,
  remove (organiser or staff, audit logged, optional reason) and leave. Open trips join at once.
- **Rules:** no joining your own trip, one pending request at a time, private trips/drafts/
  blocked organisers hidden (404), only published trips that haven't departed take people,
  removed members can't ask again, nobody decides their own request, the organiser can't be
  removed. Commercial departures are refused; bookings stay separate.
- **Transactional capacity:** approval locks the trip row and rechecks the count; a database
  trigger enforces the same limit for any write path. `FULL` follows joins, leaves and removals.
- **Lifecycle:** starting a trip, cancelling it or expiry closes pending requests (`CANCELLED`);
  completing marks participants `COMPLETED`, who keep access to the trip.
- **In-app notifications** (`apps/api/src/notifications`): new request or join, approved,
  declined, removed, trip updated (schedule and places), trip cancelled, and a once-only reminder
  within 24 hours of departure. List, unread count, mark read and mark all read.
- **Mobile:** the trip page shows "Ask to join" / "Join trip" with a note, the pending state with
  "Withdraw request", "Leave trip" with confirmation, removed and declined messages, and for the
  organiser "Join requests (n)". New screens: join requests (approve/decline with reason) and
  people on the trip (organiser can remove with reason). The Inbox lists notifications, opens
  the right screen and marks them read.

### Database changes

Migration `20261120120000_participation`; see `docs/DATABASE.md`.

### Tests

- 18 new end-to-end tests: approval flow with notifications, declining and asking again,
  withdrawing, open trips, my requests, own trip/duplicates/self-approval/non-organiser
  decisions, private/draft/blocked (404), cancelled/full/started trips, **five simultaneous
  approvals for one free place (exactly one succeeds)**, the database trigger, participant
  visibility, leaving and rejoining, audited removal, update/cancel notifications, completion,
  reminder sent once, expiry closing requests, and notification ownership.
- Unit tests for the new join/leave actions.

### Outstanding

- ~~Invitations to private trips~~ and ~~co-organisers~~: done in milestone 08.
- Notifications are in-app only; push and email arrive with milestone 09.

---

## Milestone 06: Discovery and geospatial search (2026-11-20)

### Implemented

- **API** (`apps/api/src/discovery`): `GET /discovery/search`, `/nearby`, `/trending`,
  `/destinations`. Filters for text, mode, activity, meeting point and destination names, dates,
  budget, open places, status, difficulty, bike type and engine size, and distance from a point.
- **PostGIS** for distance (`ST_DWithin`, `ST_Distance` on geography), Postgres full-text search
  for text, partial indexes that cover only discoverable trips.
- **Transparent ranking:** weighted text match, proximity, soonness, open places and saved
  preferences; every result lists why it is there. Trending is joins in the last 7 days.
- **Privacy:** only public, published trips; blocks both ways; meeting points rounded to about
  1 km; distances are whole km and labelled straight-line; the searcher's location is not stored
  or logged; the app asks for location only on "Near me" and rounds it to about 100 m.
- **Configurable radius:** `DISCOVERY_DEFAULT_RADIUS_KM` (25) and `DISCOVERY_MAX_RADIUS_KM` (200).
- **Bike types on rides:** organisers can say which bikes a ride suits (empty = any); searchers
  filter by their bike type and engine size.
- **Mobile Explore:** search bar, Ride/Travel switch, "Near me", filter sheet (sort, dates,
  activity, difficulty, bike, budget, places, distance, full trips), list/map toggle, trip cards
  with reasons, popular destinations, trending, loading skeletons, empty state and "Clear
  filters". Native maps use `react-native-maps` with 1 km circles, not pins; the web build lists
  meeting areas with Google Maps links. No search history is kept (not useful enough to justify
  storing what people search for).

### Database changes

Migration `20261120110000_discovery`; see `docs/DATABASE.md` (including the query plan review).

### Tests

- 25 new end-to-end tests: coordinate and radius validation, radius limits, no-location
  behaviour, private/draft/cancelled/blocked exclusion, approximate points, every filter, sorting,
  ranking, pagination and cursor limits, trending and destinations.
- Unit tests for tsquery building, LIKE escaping, cursors, reasons and the bike-type rule; mobile
  tests for filter-to-query mapping, location rounding and date windows.

### Outstanding

- Android release builds need a Google Maps SDK key for `react-native-maps` (a separate,
  app-restricted key); Expo Go works without one. iOS uses Apple Maps.
- Destination grouping is by name; places spelled differently stay separate until destinations
  are linked to Google place ids.
- Discovery of community-only and followers-only trips arrives with milestone 08.

---

## Milestone 05 follow-up: Google Maps, date picker, cover photos (2026-11-20)

### Implemented

- **Google place search** (`apps/api/src/integrations`): Places API (New) autocomplete and
  details, called by the API so the key stays on the server; India only, biased to Bengaluru,
  session tokens for billing, rate limited. The app's place fields search Google and fill the
  coordinates, with typed coordinates as a fallback.
- **Road distance and time:** Google Routes API (`TWO_WHEELER` for rides, `DRIVE` for travel)
  through all stops, stored on the trip and shown as "Road route … (Google Maps)" next to the
  organiser's own estimates, which stay separate. No route is shown when Google has none.
- **Open in Google Maps** link on the trip page (public URL scheme, no key); the meeting point is
  included only for people who can see the exact spot.
- **Date and time pickers:** native pickers on iOS/Android, the browser's picker on web.
- **Cover photos:** signed direct upload to Cloudinary (folder, random id and formats fixed by the
  signature, metadata stripped); the API accepts only the caller's own uploads and checks size.
- **Off until configured:** `GET /features` tells the app what is set up; unconfigured features
  return 503 and the app falls back or hides them.

### Database changes

Migration `20261120093000_trip_route_and_cover`; see `docs/DATABASE.md`.

### Outstanding

- Real `GOOGLE_MAPS_API_KEY` and Cloudinary credentials are needed in the server environment;
  until then these features are off. They were tested against recorded responses, not live.
- A rendered map in the app needs `react-native-maps` and a development build (later milestone).
- Cover photos are not yet moderated (milestone 10); size is checked after upload.

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
