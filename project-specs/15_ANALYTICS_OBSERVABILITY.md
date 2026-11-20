# 15 --- Analytics, Observability and Operations

Build product analytics and operational monitoring.

## Product events

Track privacy-conscious events: - account_registered -
profile_completed - trip_created - trip_published - trip_viewed -
join_requested - join_approved - trip_started - trip_completed -
trip_cancelled - community_joined - booking_started -
booking_confirmed - subscription_started

Do not send sensitive personal information or precise live coordinates
to analytics.

## Business metrics

-   daily/monthly active users
-   registration conversion
-   profile completion
-   trips created
-   trips with join requests
-   trip completion rate
-   repeat organiser rate
-   30-day retention
-   GMV
-   platform commission revenue
-   subscription MRR
-   refund rate
-   payment success rate
-   contribution margin

North Star Metric: successfully completed group experiences per month.

## Observability

-   structured logs
-   error tracking
-   API latency
-   database health
-   Redis health
-   queue/job failures if queues are introduced
-   payment webhook failures
-   mobile crash reporting
-   uptime checks

## Operations

-   backup schedule
-   restore drills
-   incident runbook
-   support escalation
-   moderation SLA
-   payment reconciliation
-   data retention jobs

## Deliverables

-   analytics event dictionary
-   admin metrics dashboard
-   monitoring configuration
-   backup/restore documentation
-   incident runbook

## Completion gate

Key product and operational metrics are measurable without collecting
unnecessary personal data. Update docs.
