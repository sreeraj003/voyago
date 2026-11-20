# 01 --- Project Foundation and Architecture

You are the principal engineer responsible for establishing the
foundation of a production-oriented social riding and travel platform.

## Product

Build a mobile-first platform with two modes: - **Ride:** motorcycle
rides and riding communities. - **Travel:** road trips, backpacking,
group travel and travel companions.

Initial market: Bengaluru, India. Community members can create free
trips. Commercial paid experiences will be introduced later and must be
kept separate from free community trips.

## Task

First inspect the repository. Preserve existing working code. If the
repository is empty, create a monorepo with:

-   `apps/mobile` --- Expo React Native app.
-   `apps/api` --- NestJS backend.
-   `apps/admin` --- React admin web app.
-   `packages/shared` --- shared TypeScript types and validation
    schemas.
-   `docs` --- architecture and progress documentation.
-   `infra` --- Docker and deployment configuration.

Use a workspace tool such as pnpm workspaces. Choose compatible stable
package versions and record them.

## Architecture

Start with a modular monolith: - NestJS modules organised by domain. -
PostgreSQL as source of truth. - PostGIS for geospatial queries. -
Prisma for database access. - Redis for cache, transient presence and
later location state. - Socket.IO for realtime messaging and updates. -
REST API under `/api/v1`. - React Native + Expo for mobile. - React +
TypeScript for admin.

Do not create microservices at this stage.

## Required deliverables

1.  Repository structure.
2.  Architecture diagram in `docs/ARCHITECTURE.md`.
3.  Architecture decision records in `docs/decisions/`.
4.  Root README with setup instructions.
5.  `.env.example` files containing placeholders only.
6.  Docker Compose for local PostgreSQL/PostGIS and Redis.
7.  Health endpoint.
8.  Linting, formatting and TypeScript checks.
9.  Basic CI workflow if the repository supports it.
10. `docs/DEVELOPMENT_PROGRESS.md`.

## Engineering requirements

-   Strict TypeScript.
-   Consistent error response format.
-   Structured logging.
-   Environment validation at startup.
-   No secrets in Git.
-   No mock integration presented as real.
-   Add a small smoke test proving the API starts and health endpoint
    works.

## Completion gate

Do not proceed until: - A fresh clone can be installed using documented
commands. - Docker services start. - Database connectivity works. - API
health endpoint passes. - TypeScript and lint checks pass. - README and
progress file are updated.

At the end, report changed files, commands run, test results and
unresolved issues. Do not begin authentication or trip features in this
milestone.
