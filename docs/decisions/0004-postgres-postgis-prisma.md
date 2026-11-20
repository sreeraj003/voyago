# 0004. PostgreSQL + PostGIS with Prisma

- Status: Accepted
- Date: 2026-11-20

## Context

Discovery depends on geospatial queries ("rides starting within 25 km", "trips to Coorg"). The data is
relational (users, trips, participants, communities).

## Decision

PostgreSQL 16 with PostGIS 3.5 as the source of truth. Prisma 7 (`prisma-client` generator, ESM
output, `@prisma/adapter-pg` driver adapter) for schema, migrations and typed queries. PostGIS
columns and spatial indexes are written as raw SQL inside Prisma migrations and queried through
`$queryRaw` in small repository helpers, because Prisma does not model geography types natively.

## Consequences

- Every schema change is a reviewed migration; production data is never edited by hand.
- Spatial queries are raw SQL and need their own tests against a real PostGIS database.
