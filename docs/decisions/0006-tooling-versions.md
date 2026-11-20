# 0006. Tooling and pinned versions

- Status: Accepted
- Date: 2026-11-20

## Context

The spec asks for compatible, stable versions, recorded.

## Decision

Exact versions are pinned in each `package.json` (Expo packages use `~` ranges as `expo install`
recommends). Key choices as of 2026-11-20:

| Tool          | Version          | Note                                              |
| ------------- | ---------------- | ------------------------------------------------- |
| Node.js       | 22 LTS           | `.nvmrc`; CI uses 22                              |
| pnpm          | 10.28.0          | `packageManager` field                            |
| TypeScript    | 6.0.3            | 7.x not yet supported by typescript-eslint        |
| NestJS        | 12.5.1           | ESM output (Nest 12 default)                      |
| Prisma        | 7.10.1           | 8.x is still a release candidate                  |
| Expo SDK      | 58               | React Native 0.88.1, React 19.3.0                 |
| React (admin) | 19.3.0           | Same version as mobile to avoid duplicate copies  |
| Vite / Vitest | 8.3.8 / 5.1.1    | API and admin tests                               |
| Jest          | 30.5.2           | Mobile tests via `jest-expo`                      |
| ESLint        | 10.15.0          | typescript-eslint 8.73.0, flat config at the root |
| PostgreSQL    | 16 + PostGIS 3.5 | `postgis/postgis:16-3.5-alpine`                   |
| Redis         | 7.4              | `redis:7.4-alpine`                                |

Tests: Vitest + Supertest for the API (the NestJS 12 default, Jest-compatible API) and the admin app;
Jest + React Native Testing Library for mobile.

## Consequences

Upgrades are deliberate: bump in a dedicated PR and update this table.
