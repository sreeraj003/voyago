# Social Riding & Travel Platform --- Development Pack

This pack breaks the platform build into separate, sequential prompts.
Give your coding agent **one file at a time**, in numeric order. Do not
paste all prompts at once.

## Recommended workflow

1.  Open your project repository in Cursor, Claude Code, Codex, or your
    chosen coding agent.
2.  Give it `01_PROJECT_FOUNDATION.md`.
3.  Review the implementation, run the tests, and commit the work.
4.  Only then provide the next file.
5.  Ask the agent to update `docs/DEVELOPMENT_PROGRESS.md` after every
    milestone.

## Core product decisions

-   Product: social discovery for motorcycle rides and group travel.
-   Modes: **Ride** and **Travel**.
-   Initial launch: Bengaluru, India.
-   Community members can create free trips.
-   Paid commercial experiences are separate and restricted to
    appropriately verified operators.
-   Do not implement paid passenger transport, driver matching, or
    ride-hailing in the MVP. Obtain legal advice before adding regulated
    transport functionality.
-   Core safety, blocking, reporting, and privacy controls are not
    premium features.
-   Build a modular monolith first; do not introduce microservices
    prematurely.

## Suggested stack

-   Mobile: React Native, Expo, TypeScript, Expo Router.
-   Backend: Node.js, NestJS, TypeScript.
-   Database: PostgreSQL + PostGIS, Prisma.
-   Realtime/cache: Socket.IO + Redis.
-   Admin: React + TypeScript.
-   Validation: Zod or class-validator.
-   Tests: Jest, Supertest, and mobile component/E2E tests.
-   Infrastructure: Docker Compose for local development.

## Milestones

  File   Milestone
  ------ ----------------------------------------------------
  01     Project foundation and architecture
  02     Database design and migrations
  03     Backend foundation and API conventions
  04     Authentication and user profiles
  05     Trip creation and lifecycle
  06     Discovery and geospatial search
  07     Join requests and participant management
  08     Communities and social graph
  09     Chat and notifications
  10     Admin dashboard and moderation
  11     Live location and safety workflows
  12     Commercial operators and packages
  13     Bookings, payments, commissions and refunds
  14     Subscriptions and monetisation
  15     Analytics, observability and operations
  16     Security, testing, launch readiness and deployment

## Rules for the coding agent

-   Inspect the existing repository before changing it.
-   If a previous milestone is incomplete or failing, fix it before
    proceeding.
-   Never claim a feature is implemented unless it exists and has been
    tested.
-   Do not silently invent provider credentials, API keys, legal
    approvals, or integrations.
-   Use migrations; never modify production data manually.
-   Keep secrets out of source control.
-   Add tests for business rules and authorization.
-   Document assumptions and unresolved decisions.
