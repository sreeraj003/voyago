# 0003. Modular monolith backend on NestJS

- Status: Accepted
- Date: 2026-11-20

## Context

The product has about 20 functional areas (auth, trips, discovery, chat, safety, commerce, ...).
The team is small and the product is pre-launch. Microservices would add deployment, networking and
data-consistency costs with no current benefit.

## Decision

A single NestJS application organised into domain modules. Each module owns its tables and exposes a
service; other modules use only that service. REST under `/api/v1`; Socket.IO on the same app for
realtime features.

## Consequences

- One deployable, one database, simple transactions.
- Module boundaries keep a later extraction possible (e.g. realtime/location) if load requires it.
- Boundaries are enforced by convention and review for now.
