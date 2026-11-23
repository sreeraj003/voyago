# Security review (milestone 16)

Reviewed on 2026-11-23 against the code at the milestone 16 commit. Each area lists what
protects it, how that is tested, what this review changed, and what remains. This is an
engineering review. It is not a penetration test or a legal opinion; both are still needed
before public launch (see `docs/LAUNCH_READINESS.md`).

**Result: no known critical or high-severity issue remains open.** Four issues were found and
fixed in this milestone; they are marked **Fixed** below.

## Authentication and sessions

- Passwords are hashed with argon2id. Failed passwords are limited per account as well as per IP
  (`login-attempts.service.ts`).
- Access tokens are short-lived JWTs (15 minutes by default, HMAC key of 32+ characters checked
  at start-up). Refresh tokens are random, stored only as hashes, rotated on every use, and
  grouped in a session family: presenting a rotated token again revokes the whole family.
- OTP codes are stored as HMACs, expire, and have attempt limits. The dev SMS and email providers
  are refused in production, and phone and social sign-in say they are unavailable when their
  provider keys are missing, rather than pretending to work.
- Suspended or deleted accounts are refused on every request, not only at sign-in.
- Tests: `auth.e2e-spec.ts`, `users.e2e-spec.ts`, and the new parallel refresh test in
  `concurrency.e2e-spec.ts` (two refreshes with one token: exactly one succeeds).

## Authorization

- Every route requires a signed-in member unless it is marked `@Public`. Staff routes check a
  permission (role-based, `admin` module); resource routes check ownership or trip membership in
  the service.
- **New:** `authorization-sweep.e2e-spec.ts` walks every route the app serves (over 100):
  - the public routes must equal a reviewed list of 21 (health, metrics, sign-in and sign-up,
    signed checkout pages, the signed payment webhook), so a new public route fails CI until
    someone reviews it;
  - every other route answers 401 without a token, and 401 to a forged token;
  - every `/admin` route answers 403 to an ordinary member.
- Per-resource checks (another member's trip, chat, booking, report) are covered in each
  feature's tests.

## Rate limiting

- A global limit per client IP (`RATE_LIMIT_MAX` per `RATE_LIMIT_TTL_SECONDS`), a stricter limit
  on sign-in, OTP and recovery routes (`AUTH_RATE_LIMIT_MAX`), chat messages per member per
  minute, one live location reading per 3 seconds per member, and limits on account deletion and
  data export.
- **Fixed:** the limits were counted in each server's memory, so running two API instances
  doubled every limit. They are now counted in Redis (`redis-throttler.storage.ts`, one atomic
  script per hit) and shared by all instances. If Redis is down, each instance falls back to its
  own memory count rather than letting everything through. Tests: `redis-throttler.e2e-spec.ts`.
- `TRUST_PROXY=true` must be set behind a load balancer, or every member shares the balancer's IP.

## Input validation

- Every body, query and parameter is parsed by a Zod schema from `@voyago/shared` (the same
  schemas the apps use). Unknown fields are dropped; failures answer 400 with the field paths.
- JSON bodies are capped at 100 KB. Raw SQL is only built with Prisma's tagged templates
  (parameters, never string concatenation); `LIKE` input is escaped.
- The database enforces what must never be wrong regardless of the code: capacity, one active
  booking per seat, append-only ledger and audit log, enum and range checks
  (`database-constraints.e2e-spec.ts`).

## File uploads

- Files go from the app straight to Cloudinary with a short-lived signature from the API. The
  signature fixes the folder (per member), the allowed formats and the upload preset; the API
  checks the size and format of the result before saving the reference. The Cloudinary secret
  never leaves the server.
- Images are served through Cloudinary with `q_auto,f_auto` (format and quality chosen per
  device).
- Remaining: Cloudinary's moderation add-on (automatic nudity and violence checks) is not on.
  Reports and staff review cover images for now.

## Secrets

- All keys are environment variables, validated at start-up; templates hold no values
  (`apps/api/.env.example`, `infra/deploy/*.env.example`). `.env` files are git-ignored and
  excluded from the Docker image. CI uses throwaway values.
- Logs redact authorization headers, cookies, tokens, passwords and codes, and log the path
  without the query string (which can hold search terms or coordinates).
- The data export was checked to contain no password, token or code hashes (test in
  `account.e2e-spec.ts`).

## CORS and headers

- Helmet sets the standard security headers. CORS allows only the origins in `CORS_ORIGINS`.
- **Fixed:** production now refuses to start when a CORS origin is not https.
- **Fixed:** the interactive API reference (`/api/docs`) is now off in production unless
  `API_DOCS_ENABLED=true`. It exposed nothing secret but mapped the whole API for an attacker.

## Dependencies

- `pnpm audit` on 2026-11-23: one high-severity advisory (a ReDoS in `effect`, pulled in by the
  Prisma CLI). **Fixed** by pinning `effect` to 3.22.4 (`pnpm-workspace.yaml`).
- Four moderate advisories remain, all in `glob` and `minimatch` under the mobile app's Jest
  tooling. They run only on developer machines and CI, never in the app or the server. Accepted.
- Exact versions are pinned and the lockfile is frozen in CI. Re-run `pnpm audit` before each
  release.

## Privacy and location

- Discovery returns meeting points rounded to about 1 km for everyone. The exact meeting point
  is shown only to approved participants. Coordinates sent for a search are used for that query
  and are not stored or logged.
- Live location: only while the member chooses to share on a trip they are on, only to the other
  people on that trip, and only the latest reading is kept, in Redis, expiring with the sharing
  session. Nothing is written to the database. At most one reading every 3 seconds.
- Phone numbers and emails are never shown to other members. Emergency contacts are visible only
  to their owner, and are texted only when the owner raises an SOS.
- Analytics events are pseudonymous (a keyed hash, not the member id) and hold no names,
  contacts, free text or coordinates; the database enforces this.
- Retention: read notifications, ended sessions, used tokens and OTP challenges are deleted on a
  schedule; analytics after 400 days. Money records are kept for 8 years (tax law).

## Payment webhooks

- Razorpay webhooks are verified with HMAC-SHA256 and a constant-time comparison on the raw body,
  stored once per event id (repeats are ignored), and then applied by re-fetching the payment or
  subscription from Razorpay, so a forged or replayed body cannot change state on its own.
- The amount captured must equal the amount shown; mismatches are held for review and alerted.
- Live keys are refused unless `PAYMENTS_LIVE_APPROVED=true`.
- Tests: `payments.e2e-spec.ts` and `subscriptions.e2e-spec.ts` against an in-memory stand-in for
  Razorpay's documented API. Not yet run against Razorpay's own test mode (needs test keys).

## Audit log

- Staff actions (moderation, refunds, role changes, plan changes, payouts) and account deletion
  write an audit row with the actor, action, target, reason and request id.
- The table is append-only: a database trigger rejects every update and delete, including from
  the app's own connection. Checked in `database-constraints.e2e-spec.ts`; the test clean-up in
  `account.e2e-spec.ts` meets the same refusal.
- Staff can read the log in the admin app; reading it needs its own permission.

## Account deletion and data export (new)

- **Export:** `GET /me/export` returns everything held about the member as JSON (profile,
  preferences, motorcycles, emergency contacts, sign-in methods, sessions, trips, communities,
  follows and blocks, posts, messages, reviews, reports filed, bookings, payments,
  subscriptions, saved searches, notifications, analytics events). No secrets; not cached; 5 per
  hour.
- **Deletion:** `GET /me/deletion` says what will be erased, what is kept and why, and what blocks
  deletion now (organising upcoming trips, owning a community, an operator account, open bookings,
  a live subscription, a staff role). `POST /me/delete` needs the word `DELETE` and the password,
  or a sign-in in the last 15 minutes for accounts without a password. In one transaction it:
  - anonymises the account (name "Deleted member", random username, contacts and bio removed);
  - frees the member's places on trips and reopens full trips;
  - withdraws requests and invitations, and stops location sharing;
  - deletes sessions, sign-in methods, push tokens, notifications, emergency contacts, follows,
    blocks and saved searches;
  - writes an audit row.

  Afterwards every device is signed out and the email can be used again.

- Kept, without the member's name or contacts: messages in group chats (shown as "Deleted
  member"), reports about others, and bookings, payments and refunds for 8 years (tax records).
- Tests: `account.e2e-spec.ts`, and a double-submitted delete in `concurrency.e2e-spec.ts`.
  Mobile: **Profile → Your data and account** (`AccountScreen.test.tsx`).

## Concurrency (new)

**Fixed:** ten members joining an open trip at once could deadlock the database. Each join
inserted its request first, which takes a shared lock on the trip, and then asked for the trip's
exclusive lock. Joins now lock the trip first. `concurrency.e2e-spec.ts` checks:

- ten parallel joins for three free places: exactly three succeed, seven are told the trip is
  full, and the stored count is 4;
- duplicate registrations;
- parallel refreshes;
- a double-submitted deletion.

## Still to do before public launch

1. An external penetration test of the API, admin app and mobile apps.
2. Turn on Cloudinary moderation, or add a staff review queue for new images.
3. Run the payment tests against Razorpay test mode with real test keys.
4. Two-factor sign-in for staff accounts in the admin app (today: password and role only).
5. Repeat `pnpm audit` and this review before each release.
