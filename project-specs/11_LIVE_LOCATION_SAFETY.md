# 11 --- Live Location and Safety Workflows

Implement only after core trip, membership, chat and moderation features
are stable.

## Product behaviour

During an active trip, a participant may opt into sharing their live
location with authorised trip members.

Features: - start sharing - stop sharing - expiry time - active
participant map - last updated timestamp - trip check-in - trip
completion - emergency contact workflow - SOS notification workflow

## Privacy

-   Explicit opt-in.
-   Clear explanation before sharing.
-   Easy stop control.
-   Automatic expiry.
-   Only authorised trip members can view.
-   No public location endpoint.
-   Do not expose location in profile or discovery APIs.
-   Keep retention minimal and documented.
-   Do not track users in the background without appropriate platform
    permission and user awareness.

## Technical approach

-   React Native location APIs.
-   Socket.IO for live updates.
-   Redis for transient latest location state.
-   PostgreSQL for session metadata and essential audit/checkpoint
    records.
-   Validate active trip membership and session expiry on every
    update/read.
-   Apply rate limits and payload validation.

## SOS

An SOS action should: 1. Ask for confirmation unless a carefully
designed emergency interaction requires otherwise. 2. Notify configured
emergency contacts through available channels. 3. Provide the trip
identifier and last available location to authorised recipients. 4.
Record an audit event. 5. Show local emergency guidance.

Do not claim to contact police, ambulance or emergency services unless
an actual verified integration exists.

## Tests

Test consent, expiry, stop sharing, non-member denial, blocked user
restrictions, stale updates and SOS notification handling.

## Completion gate

Location sharing is private, time-limited, permissioned and tested.
Update privacy documentation.
