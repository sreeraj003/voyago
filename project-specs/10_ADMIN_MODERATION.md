# 10 --- Admin Dashboard and Moderation

Build a separate protected React + TypeScript admin web application.

## Roles

-   SUPER_ADMIN
-   MODERATOR
-   SUPPORT
-   OPERATIONS

Use backend role-based access control. Hiding frontend buttons is not
authorization.

## Dashboard

Show: - registrations - active users - trips created - trips completed -
reports awaiting review - operator verification queue - booking/payment
metrics when later available

## User management

-   search users
-   view account status
-   suspend/restore
-   view verification status
-   view relevant moderation history

## Trip moderation

-   search trips
-   review reported trips
-   hide/remove content where policy permits
-   cancel unsafe or fraudulent listings
-   record reason and audit action

## Reports

-   report queue
-   severity
-   report category
-   reporter and subject
-   evidence references
-   status
-   resolution notes
-   assignment to moderator

## Operator verification

Create a review workflow for business/operator documentation. Do not
automatically mark operators verified.

## Audit

Record privileged actions with actor, action, target, timestamp and
reason. Restrict access to sensitive documents.

## Tests

Test role permissions, audit creation, suspension and restoration,
report lifecycle and operator verification permissions.

## Completion gate

Admins can moderate the platform securely, and every privileged action
is auditable. Update docs.
