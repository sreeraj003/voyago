# 07 --- Join Requests and Participant Management

Implement the complete participation workflow.

## Rules

-   User cannot join their own trip.
-   No duplicate active join request.
-   User cannot join a private trip without permission.
-   Organiser can approve/reject requests.
-   User can withdraw a pending request.
-   Trip capacity cannot be exceeded.
-   Recheck capacity inside a database transaction during approval.
-   A user cannot approve their own request.
-   Only organiser/admin can remove a participant.
-   Removal must be audited and optionally include a reason.
-   Cancelled, expired or completed trips cannot accept new
    participants.
-   Keep commercial booking status separate from community
    participation.

## Statuses

Join request: PENDING, APPROVED, REJECTED, WITHDRAWN, CANCELLED.

Participant: ACTIVE, REMOVED, LEFT, COMPLETED.

## APIs

-   Create join request.
-   List organiser's requests.
-   Approve/reject.
-   Withdraw request.
-   List participants.
-   Remove participant.
-   Leave trip.

## Notifications

Generate in-app notifications for: - New join request. - Request
approved/rejected. - Participant removed. - Trip updated/cancelled. -
Trip approaching.

## Tests

Include concurrency tests proving that two simultaneous approvals cannot
exceed capacity. Test ownership, duplicate requests, blocked users and
invalid trip states.

## Completion gate

The full join lifecycle works end-to-end and capacity is transactionally
safe. Update docs and progress.
