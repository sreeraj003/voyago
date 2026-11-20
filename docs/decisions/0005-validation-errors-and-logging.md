# 0005. Zod validation, one error shape, structured logs

- Status: Accepted
- Date: 2026-11-20

## Context

The spec asks for strict validation, a consistent error format, structured logging and environment
validation at startup. Clients should share validation rules with the API.

## Decision

- **Validation:** Zod schemas in `@voyago/shared`, applied on the API with `ZodValidationPipe`,
  reused by mobile and admin to validate responses. (Chosen over class-validator so one schema
  serves server and clients.)
- **Errors:** every response error has the `ApiError` shape; unknown errors become a generic 500.
- **Logging:** Pino via `nestjs-pino`, JSON in production, request ids propagated through
  `x-request-id`, tokens/contact details/coordinates redacted, query strings not logged.
- **Config:** environment parsed by a Zod schema at startup; the process exits with a readable list
  of problems if anything is missing or malformed.

## Consequences

Contracts live in one place. Adding an endpoint means adding its schema to `@voyago/shared` first.
