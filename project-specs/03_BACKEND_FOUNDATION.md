# 03 --- Backend Foundation and API Conventions

Build the NestJS backend foundation without implementing the full
product modules yet.

## Requirements

-   REST prefix: `/api/v1`.
-   Global request validation.
-   Consistent success and error response conventions.
-   Central exception handling.
-   Structured request logging with correlation/request IDs.
-   Environment variable validation.
-   Swagger/OpenAPI documentation.
-   CORS configured by environment.
-   Rate limiting foundation.
-   Health and readiness endpoints.
-   Database module using Prisma.
-   Redis module with graceful connection handling.
-   Global authentication guard foundation, but do not invent
    authentication behaviour before milestone 04.

## Suggested modules

`common`, `config`, `database`, `health`, `auth`, `users`, `trips`,
`discovery`, `communities`, `chat`, `notifications`, `operators`,
`bookings`, `payments`, `subscriptions`, `reports`, `admin`.

Create modules only where useful; avoid empty boilerplate modules that
do nothing.

## API conventions

-   Use DTOs and validation.
-   Use appropriate HTTP status codes.
-   Use cursor pagination where it improves feed/discovery performance;
    document pagination shape.
-   Validate UUIDs and query parameters.
-   Never return internal stack traces to clients.
-   Do not leak database errors.
-   Document all implemented endpoints in Swagger.

## Deliverables

-   NestJS module structure.
-   Prisma service and lifecycle management.
-   Redis service.
-   Global validation and exception handling.
-   Health/readiness endpoints.
-   Swagger setup.
-   API conventions in `docs/API.md`.
-   Integration tests for health and error handling.

## Completion gate

API starts reliably, database and Redis connectivity are observable,
validation works, Swagger loads, and tests pass. Update progress
documentation.
