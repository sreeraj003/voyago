# Analytics and business metrics

Voyago records product analytics in its own database. No third-party analytics SDK runs in the
apps or the API. Members are never identified in analytics, and the source of truth for the
event list is `packages/shared/src/analytics.ts` (`ANALYTICS_EVENTS`).

## Privacy rules

- **Pseudonymous actor.** Each event stores `actor_key`, the first 32 hex characters of
  HMAC-SHA256(user id) keyed with `ANALYTICS_HASH_KEY`. If that key is empty, a key derived from
  `OTP_HMAC_SECRET` is used. The user id itself is never stored, and the key cannot be reversed
  without the secret.
- **Whitelisted properties.** An event can hold only the properties its dictionary entry lists.
  Anything else a call site passes is stripped. Invalid values drop the event and never fail the
  request. Properties are enums, booleans and bounded numbers. There are no names, contact
  details, free text, ids of other people, or coordinates.
- **Database limits as a backstop.** `properties` must be a JSON object under 1 KB, and
  `actor_key` must be 32 lowercase hex characters.
- **Retention.** Events are deleted after `ANALYTICS_RETENTION_DAYS` (default 400). A member's
  events are also deleted within 3 days of their account being deleted (see `RetentionService`).
- **Aggregates only.** The admin metrics endpoint returns counts and rates. No staff screen can
  list one member's events.

## Event dictionary

| Event                  | When it is recorded                                                                 | Properties                             |
| ---------------------- | ----------------------------------------------------------------------------------- | -------------------------------------- |
| `account_registered`   | An account is created (email, phone OTP, Google or Apple)                           | `method`                               |
| `profile_completed`    | The first time the profile has a bio, home city, a language and an interest         | none                                   |
| `trip_created`         | A trip is created as a draft                                                        | `mode`, `activityType`, `tripType`     |
| `trip_published`       | A trip is published                                                                 | `mode`, `activityType`, `tripType`     |
| `trip_viewed`          | Someone other than its organisers opens a trip; at most once per member, trip, day  | `mode`, `participant`                  |
| `join_requested`       | A member asks to join (or joins a trip that needs no approval)                      | `mode`, `approvalRequired`             |
| `join_approved`        | A request is approved, or a member joins without approval (recorded for the member) | `mode`, `automatic`                    |
| `trip_started`         | The organiser starts the trip                                                       | `mode`, `activityType`, `participants` |
| `trip_completed`       | The organiser completes the trip                                                    | `mode`, `activityType`, `participants` |
| `trip_cancelled`       | The organiser or staff cancel the trip                                              | `mode`, `by` (`organiser` / `staff`)   |
| `community_joined`     | A member joins a community, or asks to join a private one                           | `pending`                              |
| `booking_started`      | Places on a paid experience are held and a payment order is created                 | `seats`, `amountPaise`                 |
| `booking_confirmed`    | A booking is paid and confirmed (including late confirmations)                      | `seats`, `amountPaise`                 |
| `subscription_started` | A paid plan switches on after its first payment                                     | `tier`, `pricePaise`                   |
| `user_active`          | A signed-in member's first authenticated request of the day (India time)            | none                                   |

Events are recorded after the change has been committed. A failed event never undoes or fails
the action itself. `user_active` is deduplicated in Redis. Without Redis, the check for that
day's event keeps it to one.

## Business metrics (`GET /api/v1/admin/metrics?days=30`)

Computed on request from the source tables (trips, users, bookings, payments, the ledger,
subscriptions) and the events above. Days and months use India time. Rates are percentages with
one decimal, and are `null` when there is nothing to divide by.

| Metric                    | Definition                                                                                                                                                            |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **North Star**            | Completed group experiences per month: trips with status `COMPLETED` and at least 2 participants who were active or completed, by month of completion. Last 6 months. |
| DAU                       | Distinct members with `user_active` today                                                                                                                             |
| MAU                       | Distinct members with `user_active` in the last 30 days                                                                                                               |
| Stickiness                | DAU ÷ MAU                                                                                                                                                             |
| Registrations             | Member accounts (role `USER`) created in the period                                                                                                                   |
| Registration conversion   | Of those, the share that created a trip or asked to join one within 30 days of signing up                                                                             |
| Profile completion        | Of those, the share with `profile_completed_at` set                                                                                                                   |
| 30-day retention          | Of members who joined 30 to 60 days ago, the share whose last activity is 30+ days after joining                                                                      |
| Trips created / published | Trips created, and trips published, in the period                                                                                                                     |
| Trips with join requests  | Of trips published in the period, the share with at least one join request or a member who joined by invitation                                                       |
| Trip completion rate      | Of trips that departed in the period and ended as completed, cancelled or expired, the share completed                                                                |
| Repeat organiser rate     | Of organisers who published in the period, the share who had published a trip before                                                                                  |
| GMV                       | Total of bookings confirmed in the period, before refunds                                                                                                             |
| Commission revenue        | Ledger `COMMISSION` minus `COMMISSION_REVERSAL` in the period (tax on commission excluded)                                                                            |
| Subscription MRR          | Monthly price of live subscriptions that will renew (yearly prices ÷ 12)                                                                                              |
| Subscription revenue      | Subscription payments captured in the period, less their refunds                                                                                                      |
| Refund rate               | Refunded amount ÷ captured amount, bookings and subscriptions                                                                                                         |
| Payment success rate      | Captured payments ÷ (captured + failed) attempts created in the period                                                                                                |
| Provider fees             | Ledger provider fees and their tax, plus fees on subscription payments                                                                                                |
| Contribution margin       | Commission + subscription revenue (already net of refunds) − provider fees and their tax                                                                              |

The endpoint needs the `metrics.read` permission (operations and super admins). The admin app
shows it under **Metrics**.

## Adding an event

1. Add it to `ANALYTICS_EVENTS` in `packages/shared/src/analytics.ts`, with only enum, boolean
   or bounded number properties.
2. Add the value to the `AnalyticsEventName` enum in `apps/api/prisma/schema.prisma` and create
   a migration (`ALTER TYPE ... ADD VALUE`).
3. Call `AnalyticsService.track(name, userId, props)` after the change commits.
4. Add a line to the table above and a test in `apps/api/test/observability.e2e-spec.ts`.
