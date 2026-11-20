# 0002. Monorepo with pnpm workspaces and Turborepo

- Status: Accepted
- Date: 2026-11-20

## Context

The API, mobile app and admin app share request/response shapes and validation rules. Keeping them
in separate repositories invites drift between what the API accepts and what clients send.

## Decision

One repository with pnpm workspaces (`apps/*`, `packages/*`) and Turborepo for task orchestration
and caching. `node-linker=hoisted` is used because React Native's Metro bundler resolves a flat
`node_modules` most reliably. A single React version is pinned at the root (Expo SDK 58 requires
19.3.0) because duplicate React copies break hooks at runtime.

## Consequences

- One lockfile; one CI pipeline; atomic changes across API and clients.
- Hoisting means a package can accidentally import an undeclared dependency. ESLint and code review
  must catch this.
