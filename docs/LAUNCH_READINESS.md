# Launch readiness report

Date: 2026-11-23. Scope: Voyago milestones 01 to 16 (API, mobile app, admin app).

## Verdict

**Not ready for public launch. Ready for a staging environment, and for a closed Bengaluru beta
once the four beta blockers below are done.**

The engineering gates pass: tests, security review, rollback plan, performance baseline. The
gates that fail need things code cannot supply: legal review and published policies, real
devices, store accounts, and production infrastructure with a verified backup.

## Release gate

| Gate                                  | Status   | Evidence or what is missing                                                                                                                                                                                                         |
| ------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Critical tests pass                   | **Pass** | CI on every push: format, types, lint, unit tests (shared, API, admin, mobile) and the API end-to-end suite against real PostgreSQL/PostGIS and Redis. See "Testing" below.                                                         |
| No known critical security issue      | **Pass** | `docs/SECURITY_REVIEW.md`: four issues found and fixed in this milestone, none open. An external penetration test is still required before public launch.                                                                           |
| Backups and restore verified          | **Fail** | Backup and restore-drill scripts exist and the drill passed on the development database. Production has no database yet; the drill must pass on the real managed database, and point-in-time recovery must be switched on.          |
| Monitoring and support processes work | **Fail** | Metrics, alerts, the system page and runbooks exist and are tested (`docs/OPERATIONS.md`). Not yet connected to a real Prometheus, uptime checker or alert channel, and no support inbox or on-call rota is staffed.                |
| Privacy and legal documents reviewed  | **Fail** | No terms of use, privacy notice or grievance officer details exist yet. They must be written and reviewed by a lawyer (see the India checklist).                                                                                    |
| App store requirements met            | **Fail** | In-app account deletion (required by both stores) is done. Missing: EAS build profiles, store listings, privacy labels (App Store) and data-safety form (Play), a privacy policy URL, review accounts, and testing on real devices. |
| Rollback procedure documented         | **Pass** | `docs/DEPLOYMENT.md`, "Rolling back"; the migration image is separate from the API image.                                                                                                                                           |

## Testing

| Area                                | Status     | Notes                                                                                                                                                        |
| ----------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Backend unit                        | Pass       | Services, pipes, guards, money arithmetic.                                                                                                                   |
| Backend integration and API         | Pass       | End-to-end suites per feature against the real database and Redis.                                                                                           |
| Authorization                       | Pass       | Every route swept (new); per-resource checks per feature.                                                                                                    |
| Database constraints                | Pass       | Capacity, append-only ledger and audit log, enum and range checks.                                                                                           |
| Concurrency                         | Pass (new) | Parallel joins, refreshes, registrations, deletions. Found and fixed a deadlock.                                                                             |
| Payment sandbox                     | Partial    | Tested against an in-memory stand-in for Razorpay's documented API. Needs a run in Razorpay test mode with test keys.                                        |
| Mobile component and authentication | Pass       | Jest and React Native Testing Library: sign-in, mode selector, account screen, forms, API client, offline chat cache, safety, crash reporter.                |
| Mobile navigation                   | Partial    | Typed routes are checked at compile time; no automated end-to-end navigation run (Detox or Maestro) yet.                                                     |
| Device, poor network, permissions   | Not done   | Needs real Android and iOS phones: location permission denied and revoked mid-trip, airplane mode during chat and SOS, background location, low-end Android. |
| Crash testing                       | Partial    | Crash reports are captured and shown in admin **System**; not yet exercised on devices.                                                                      |
| Admin roles, moderation and audit   | Pass       | API tests for every role and permission, moderation workflows and audit rows; admin app unit tests.                                                          |

## Performance

Baseline in `docs/DEPLOYMENT.md`, "Performance baseline". On 50,000 trips, searching near a point
went from 24 s to 0.1 s and trending from 0.75 s to 0.1 s. 1,000 realtime connections opened in
1.3 s. Pagination is capped at 100 per page everywhere. Live location is limited to one reading
every 3 seconds per member.

Known limits:

- Discovery cost grows with the number of open trips inside the search radius. That is fine for a
  city beta. Revisit it beyond about 10,000 open trips in one city, for example with a two-step
  query that ranks first and builds the cards second.
- Community chat and community posts fan out to every member in one query. Fine at hundreds of
  members; needs batching before communities reach tens of thousands.

## India launch checklist

Get professional advice on each item before any public or commercial launch. Nothing here has
been obtained or approved yet. The "product today" column says what the app already does, so the
lawyer can review it. It is not a claim of compliance.

| Item                                     | Status      | Product today                                                                                                                                                                                                                                            |
| ---------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DPDP Act 2023 and the DPDP Rules         | Not started | Data export and account deletion, location used only after the member allows it, pseudonymous analytics, retention jobs, data held in India once hosted there. Needs a privacy notice, consent records review, a grievance officer and a breach process. |
| Consumer protection and e-commerce rules | Not started | Clear prices and renewal terms, cancellation in the same place as subscribing, reminders before renewals, no dark patterns. Needs a legal review of terms and refund policy.                                                                             |
| GST and invoicing                        | Not started | Commission and GST on commission are recorded in the ledger. GST invoices are not generated yet. Needs a tax adviser and GST registration.                                                                                                               |
| Payment marketplace responsibilities     | Not started | Razorpay only; live keys refused until `PAYMENTS_LIVE_APPROVED=true`. Needs Razorpay's marketplace or Route approval, settlement and escrow structure, and payout terms.                                                                                 |
| Transport aggregator rules               | Not started | Voyago does not sell, match or dispatch passenger transport: community trips share costs among members, and commercial packages are sold by verified operators. Confirm this position with counsel before any paid trip.                                 |
| Karnataka-specific requirements          | Not started | Bengaluru first. Check state transport and tourism rules for organised group trips and commercial operators.                                                                                                                                             |
| Commercial travel operator obligations   | Not started | Operators are verified by staff from uploaded documents. Needs the operator agreement and a list of documents counsel requires.                                                                                                                          |
| Insurance and liability                  | Not started | Safety features (SOS, live location, check-ins) are free. Needs advice on platform liability, operator insurance and the waiver wording.                                                                                                                 |
| Terms, privacy policy, grievance process | Not started | None written. Required before the beta (personal data is collected).                                                                                                                                                                                     |

Paid passenger transport, driver matching and ride-hailing are out of scope and must not be built
or launched on the strength of this technical work.

## Bengaluru closed beta

**Blockers (do these first):**

1. Terms of use, a privacy notice and a grievance contact, reviewed by a lawyer and linked from
   sign-up and the profile screen.
2. Staging and production hosted in an Indian region, with a passing restore drill on the real
   database and alerts reaching a person.
3. EAS build profiles and internal test tracks (TestFlight and Play internal testing). The beta is
   closed by who receives the build.
4. One pass on real devices (two Android phones including a low-end one, one iPhone) through the
   device checklist below.

Keep paid features off for the beta (`PAYMENT_PROVIDER=none`): community trips are free.

**Plan:**

| Step     | Detail                                                                                                                                        |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Recruit  | 10 to 15 organisers who already run rides or weekend trips (riding clubs, trekking groups), and the 100 to 200 people they already ride with. |
| Onboard  | A 20-minute call per organiser: create and publish a trip, approve requests, use chat, safety and SOS. A one-page safety note for members.    |
| Run      | 4 to 6 weeks of real trips around Bengaluru (Nandi Hills, Coorg, Chikmagalur and so on).                                                      |
| Feedback | In-app report and a weekly 15-minute call with each organiser. Review every safety report within the moderation SLA.                          |
| Measure  | Completed group experiences per week (the North Star), repeat trips per organiser, joins per trip, 30-day retention, crash-free sessions.     |
| Fix      | Safety and reliability first. Nothing new ships in the beta unless it fixes one of those.                                                     |

**Exit criteria for a wider launch:**

- No open safety issue.
- Crash-free sessions above 99.5%.
- At least half the organisers have run a second trip.
- Restore drill passed in the month before.
- The legal checklist is signed off for the features being launched.

**Device checklist:** sign up with email and phone, deny location then allow it, revoke location
mid-trip, share live location with the screen locked, SOS in airplane mode (check what the member is told), chat on a slow 3G profile, kill the app mid-upload, delete the account.

## Outstanding risks

| Risk                                             | Impact | Mitigation                                                                              |
| ------------------------------------------------ | ------ | --------------------------------------------------------------------------------------- |
| No legal review or policies yet                  | High   | Beta blocker 1; no public launch without it.                                            |
| Safety features untested on real phones          | High   | Beta blocker 4; SOS and live location are the first things tested.                      |
| No external penetration test                     | Medium | Before public launch; the authorization sweep and review reduce the risk meanwhile.     |
| Payments only tested against a stand-in          | Medium | Payments stay off for the beta; run in Razorpay test mode before switching them on.     |
| Single region, no failover                       | Medium | Managed database with point-in-time recovery; restore drill monthly.                    |
| Staff accounts have no second factor             | Medium | Few staff in the beta; add two-factor sign-in to the admin app before growing the team. |
| Image moderation is manual                       | Low    | Reports and staff review; turn on Cloudinary moderation.                                |
| Prices for paid plans not validated with members | Low    | Paid plans stay off in the beta.                                                        |
