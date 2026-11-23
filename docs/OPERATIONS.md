# Operations

How Voyago is watched, backed up and run day to day. Business metric definitions are in
`docs/ANALYTICS.md`.

## At a glance

| What                     | Where                                                                          |
| ------------------------ | ------------------------------------------------------------------------------ |
| Liveness                 | `GET /api/v1/health/live`: the process is up                                   |
| Readiness                | `GET /api/v1/health/ready`: database, PostGIS and Redis reachable (503 if not) |
| System status (staff)    | Admin app, **System** (`GET /api/v1/admin/system`, `system.read`)              |
| Business metrics (staff) | Admin app, **Metrics** (`GET /api/v1/admin/metrics`, `metrics.read`)           |
| Prometheus metrics       | `GET /api/v1/metrics` with `Authorization: Bearer $METRICS_TOKEN`              |
| Alert rules              | `infra/monitoring/alerts.yml`; scrape config `infra/monitoring/prometheus.yml` |
| Backups                  | `scripts/backup.sh`; drills with `scripts/restore-drill.sh`                    |
| Deploying and rollback   | `docs/DEPLOYMENT.md`                                                           |
| Load tests               | `scripts/perf/` (volume data, HTTP and realtime load)                          |

## Configuration

All optional. With none of them set the app runs the same and the admin pages still work.

| Key                        | Effect                                                                                                                                                                |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `METRICS_TOKEN`            | At least 24 characters. Turns on `/api/v1/metrics` for requests with this bearer token. Unset: 404.                                                                   |
| `ALERT_WEBHOOK_URL`        | An https URL that accepts `{"text": "..."}` (a Slack or Google Chat incoming webhook, for example). Alerts are always logged at error level; this sends them too.     |
| `ANALYTICS_HASH_KEY`       | At least 32 characters. The key for pseudonymous actor keys. Unset: derived from `OTP_HMAC_SECRET`. Changing it splits every member's history in two, so set it once. |
| `ANALYTICS_RETENTION_DAYS` | 30 to 1095, default 400.                                                                                                                                              |

## Monitoring

### Logs

The API writes structured JSON logs (pino) with a request id on every line. The same id is
returned as `x-request-id` and in error bodies, so a support ticket can be traced to its log
lines. Request bodies, authorization headers, tokens and passwords are never logged.

### Metrics

`/api/v1/metrics` serves the Prometheus text format. Every label is a route pattern
(`/api/v1/trips/:id`), a method, a status, a job name or a dependency name. Labels never hold ids,
filled-in paths or member data.

| Metric                                                                 | Meaning                                                            |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `http_requests_total{method,route,status}`                             | Requests                                                           |
| `http_request_duration_seconds_bucket{method,route,le}`                | Latency histogram                                                  |
| `dependency_up{name}`, `dependency_latency_ms{name}`                   | Database and Redis probes (refreshed on each scrape)               |
| `job_runs_total{job,outcome}`                                          | Background job runs                                                |
| `job_last_success_timestamp_seconds{job}`                              | Last success per job                                               |
| `payment_webhooks_total{provider,outcome}`                             | Webhooks: processed, duplicate, ignored, invalid_signature, failed |
| `payment_webhooks_stuck`                                               | Valid provider events not applied after 10 minutes                 |
| `moderation_reports_overdue`                                           | Open reports past their response target                            |
| `client_errors_total{platform,fatal}`                                  | App crash and error reports                                        |
| `analytics_events_total{name}`, `analytics_event_failures_total{name}` | Product events recorded or dropped                                 |
| `alerts_total{kind}`                                                   | Alerts raised by the API itself                                    |

Metrics are kept in memory per API instance and reset on restart. With several instances,
scrape each one.

### Uptime checks

Check `/api/v1/health/live` and `/api/v1/health/ready` from outside every 30 to 60 seconds. Any
uptime service works. `infra/monitoring/prometheus.yml` shows the blackbox exporter set-up. Page
when readiness fails for 2 minutes.

### Error tracking

- **API:** every 5xx is logged with its request id and stack, and raises a `server-error` alert,
  at most one per 15 minutes per kind so a burst sends one message.
- **Apps:** the mobile app (React Native global handler) and the admin app (`error` and
  `unhandledrejection`) send crash reports to `POST /api/v1/client-errors`. A report holds only
  the platform, app version, error class and message, up to 30 stack lines, and the screen's route
  pattern (`/trips/[id]`). It never holds the filled-in path, screen contents or the account. The
  API scrubs the text again on arrival (emails, phone numbers, ids, tokens, coordinates, query
  strings), logs it, and counts it per hour. The endpoint is rate limited to 20 a minute per
  client, and each app sends at most 10 a session.
- **Native crashes** (outside JavaScript) are not captured yet. They need a native SDK; see
  milestone 16.

### Background jobs

Every interval job runs through `JobMonitor`. It records each run in `job_runs`, never lets a
failure escape, skips a tick while the previous run is still going, and alerts after 3 failures
in a row. Admin **System** shows each job with its last success, its last error, and whether it
is healthy. A job is unhealthy when it is failing, or when it has not succeeded within 3
intervals (at least 3 minutes).

| Job                      | Every   | Does                                                                                          |
| ------------------------ | ------- | --------------------------------------------------------------------------------------------- |
| `push-delivery`          | 2 s     | Sends pushes for new notifications (only with a push provider)                                |
| `safety-sweep`           | 30 s    | Ends expired live-location sessions, clears old SOS locations                                 |
| `payment-reconciliation` | 1 min   | Checks pending payments with the provider, releases lapsed holds, completes finished bookings |
| `subscription-sweep`     | 10 min  | Renewal reminders, ends lapsed plans                                                          |
| `trip-reminders`         | 15 min  | Day-before trip reminders                                                                     |
| `trip-expiry`            | 15 min  | Expires published trips that never started                                                    |
| `saved-search-alerts`    | 1 hour  | New-trip alerts for saved searches                                                            |
| `data-retention`         | 6 hours | Deletes data past retention (below)                                                           |

Each job is safe to run on several instances at once (conditional updates or `SKIP LOCKED`).

## Backups

- **Schedule:** a full `pg_dump` every 6 hours and before every deploy that has a migration. Keep
  14 days of local copies plus an off-site, encrypted copy: 30 days of dailies and 12 monthlies.
  If the managed database offers point-in-time recovery, turn it on as well (target: 5 minutes of
  data loss at most). The dumps are the copy that does not depend on that provider.
- **Command:** `DATABASE_URL=... BACKUP_DIR=... scripts/backup.sh`. It writes a compressed
  custom-format dump and a sha256 file, checks that the dump can be read, copies it off-site when
  `BACKUP_UPLOAD_CMD` is set, and deletes local copies older than `BACKUP_KEEP_DAYS`.
- **What is in it:** the whole database, including payments, the ledger and the audit log. Treat
  backups as personal data: encrypted at rest, with access limited to the on-call engineers.
- **Not in it:** Redis. It holds rate limits, caches and short-lived dedupe keys, and rebuilds
  itself. Cover photos and documents are in Cloudinary, which has its own backups.

## Restore drills

Monthly, and after any change to the schema tooling:

1. Take the latest off-site backup, not a local one.
2. Run `RESTORE_ADMIN_URL=postgresql://.../postgres scripts/restore-drill.sh <file>` against a
   staging server. It checks the checksum, restores into a new scratch database, prints row
   counts (users, trips, bookings, payments, ledger, audit log) and the migration state, then
   drops the scratch database.
3. Record the date, backup age, restore time and the counts in the ops log. Target: a restore
   in under 30 minutes, from a backup under 6 hours old.

The drill was run on 2026-11-23 against the development database. It took about 1 second for a
316 KB dump, with 16 migrations applied and none failed.

**Real restore (incident):** stop the API (or put it in maintenance mode), restore into a new
database with `pg_restore --no-owner --dbname=...`, run `pnpm db:migrate` (a no-op if the backup
is current), point `DATABASE_URL` at it, start the API, and check `/health/ready` and admin
**System**. Then run payment reconciliation so that payments captured after the backup are
re-fetched from the provider. Provider events are stored once per event id, so replaying them is
safe.

## Data retention

Run by the `data-retention` job (`apps/api/src/observability/retention.service.ts`).

| Data                                       | Kept                                                                            |
| ------------------------------------------ | ------------------------------------------------------------------------------- |
| Analytics events                           | `ANALYTICS_RETENTION_DAYS` (400 days); a deleted account's events within 3 days |
| Read notifications                         | 180 days after being read                                                       |
| Sign-in sessions                           | 30 days after expiring or being revoked                                         |
| Email and reset tokens                     | 7 days after use or expiry                                                      |
| Phone OTP challenges                       | 1 day                                                                           |
| Job run records                            | 30 days without a run                                                           |
| Live location and SOS positions            | Ended by the safety sweep (milestone 11 rules)                                  |
| Payments, refunds, ledger, provider events | **Not deleted**: kept for accounting and tax (at least 8 years)                 |
| Audit log                                  | **Not deleted**: append-only                                                    |
| Crash reports                              | Only in logs (keep logs 30 days) and as hourly counts in Redis (26 hours)       |

## Moderation SLA

The first response is due within these hours of a report (`MODERATION_SLA_HOURS`):

| Severity | Response |
| -------- | -------- |
| Critical | 1 hour   |
| High     | 4 hours  |
| Medium   | 24 hours |
| Low      | 72 hours |

Admin **System** shows open reports, how many are overdue, and the oldest. An alert fires when
any report has been overdue for 30 minutes. Critical reports (threats, safety emergencies) go to
whoever is on call. Out of hours, the on-call engineer suspends the account or hides the content
first, and the moderator reviews it in the morning.

## Support escalation

1. **Support** (`SUPPORT` role) answers members, finds their account, trips and payments, and
   opens a report or a note. Support cannot refund or change money.
2. **Operations** (`OPERATIONS`): refunds, ending subscriptions, operator verification, payment
   reconciliation.
3. **Moderators**: reports and content, suspensions.
4. **On-call engineer**: anything in the runbook below, or any bug that loses data, blocks
   payments, or exposes personal data.
5. **Super admin / founders**: legal requests, data breaches, police requests, provider account
   issues.

Safety emergencies (SOS, threats) go straight to step 4 with the moderator informed. Voyago is
not an emergency service; members are told to call 112.

## Payment reconciliation

- **Automatic:** `payment-reconciliation` re-checks every pending payment with the provider each
  minute, confirms paid bookings, releases lapsed holds, and refunds payments that arrive after a
  hold was released. Subscriptions are re-fetched on every webhook and by the 10-minute sweep.
- **Daily (operations):** in admin **System**, check that stuck webhooks, failed refunds and
  amount mismatches are all zero. Then compare yesterday's captured total in **Payments** with
  the provider dashboard's settlement report. Differences go to an engineer with the payment ids.
- **Failed refund:** retry it from the booking page in **Payments**. If it fails again, refund it
  in the provider dashboard and record the provider refund id in the reason.
- **Amount mismatch:** the booking stays unconfirmed. Refund it in full and tell the member.

## Incident runbook

**First 10 minutes, any incident:** acknowledge the alert. Open admin **System** and the
logs (filter by request id or `alert`). Decide the severity: **SEV1** means members cannot sign
in, pay or use safety features, or data is exposed. **SEV2** means a feature is broken. **SEV3**
means degraded. For SEV1, post a status note within 30 minutes and update it every 30 minutes.
Write a short post-incident review within 3 working days: what happened, the impact, what fixed
it, what will stop it happening again.

### API down or 503s

1. `/health/ready` names the failing dependency. If it says the database or Redis, go to the
   next section.
2. If the process is crashing, check the last deploy. Roll back to the previous image, then
   investigate.
3. A failed migration shows in the logs at start-up. Never edit production data by hand: fix
   the migration, or restore (see Backups).

### Database or Redis down

- **Database:** check the provider's status page, connection limits and disk. The API returns 503
  until it is back; no data is written meanwhile.
- **Redis:** rate limits, chat fan-out and analytics dedupe degrade, but the API keeps serving.
  Restart Redis; nothing needs restoring.

### Error spike

Group the logs by route. If one deploy introduced it, roll back. If it is one provider (maps,
email, SMS, push), the related feature degrades and the rest works; check the provider's status.

### Slow API

Use the `slowest` routes in admin **System**, then check the database for long queries
(`pg_stat_activity`) and missing indexes.

Discovery is the heaviest read. If it is slow, check that `DATABASE_SESSION_OPTIONS` is applied
(`SHOW jit` on an app connection should say `off`), run `ANALYZE trips`, and compare the plan with
the reviewed ones in `docs/DATABASE.md`. Rate limits live in Redis: if Redis is down, limits are per
instance until it returns.

### Background job failing

Admin **System** shows the last error. Fix the cause; the next run picks up where it left off.
For `payment-reconciliation` or `safety-sweep`, treat it as SEV1 if it fails for more than
15 minutes.

### Payment webhooks failing

- **Bad signatures:** check `RAZORPAY_WEBHOOK_SECRET` against the provider dashboard. A burst
  with a correct secret is probing; those requests are already ignored.
- **Failed to apply:** the event stays unprocessed and the provider retries it. Fix the cause.
  Reconciliation also re-fetches every pending payment, so bookings settle either way.

### Moderation SLA

Assign the overdue reports. If the queue is growing, call in another moderator.

### App crash spike

Group the crash reports in the logs by message and route. If it started with an app release,
pause the staged rollout in the stores.

### Data exposure

Treat as SEV1. Stop the exposure (feature flag, rollback, or revoke the key), keep the logs,
inform the founders. Under India's DPDP Act the Data Protection Board and the affected people
must be told; legal review decides the wording and timing.
