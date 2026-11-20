# 02 --- Database Design and Migrations

Implement the initial relational data model using PostgreSQL, PostGIS
and Prisma.

## First inspect

Read `docs/ARCHITECTURE.md`, the existing Prisma setup and current
migrations. Do not overwrite existing work.

## Entities

Design the schema for: - users - user_preferences - motorcycles -
trips - trip_stops - trip_participants - trip_join_requests -
communities - community_members - follows - conversations -
conversation_members - messages - notifications - reviews - reports -
commercial_operators - commercial_packages - bookings - payments -
subscription_plans - subscriptions - location_sessions - audit_logs

Not every table needs to be exposed through APIs in this milestone.
Establish a sound schema and document deferred entities.

## Key design rules

-   Use UUID primary keys.
-   Use UTC timestamps.
-   Add created_at and updated_at where appropriate.
-   Add foreign keys and deliberate delete behaviour.
-   Add uniqueness constraints for usernames, memberships, follows and
    trip participation.
-   Use enums for stable lifecycle states.
-   Use PostGIS geography/geometry for trip origin, destination and
    stops.
-   Keep exact user location private.
-   Do not store payment card data.
-   Keep community trip participation separate from commercial bookings.
-   Keep commercial operators and commercial packages separate from
    community organisers and free trips.
-   Store money as integer minor units (paise) or a clearly documented
    decimal representation. Never use floating-point for money.
-   Add indexes for common lookup and filtering paths.
-   Add audit records for privileged and financially significant
    actions.

## Important trip fields

Trips should include: - organiser_id - title and description -
activity_type - trip_type: COMMUNITY_FREE or COMMERCIAL_PAID -
visibility - origin and destination - departure_at and return_at -
max_participants and min_participants - estimated_budget and currency -
status - approval_required - cover image reference

Do not allow ordinary community trips to become paid passenger transport
listings.

## Deliverables

1.  Prisma schema.
2.  Initial migration(s).
3.  Seed script with clearly labelled development-only sample data.
4.  ER diagram in `docs/DATABASE.md` (Mermaid is acceptable).
5.  Index and constraint rationale.
6.  Migration and reset commands in README.
7.  Tests for key uniqueness and foreign-key constraints.

## Completion gate

-   Migrations apply to a clean database.
-   Seed runs safely in development.
-   Prisma client generates.
-   Tests verify core constraints.
-   PostGIS extension is enabled and spatial columns work.
-   No secrets or production data in seeds.

Update `docs/DEVELOPMENT_PROGRESS.md` and report all commands and test
results.
