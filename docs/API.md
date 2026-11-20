# Voyago API conventions

Every endpoint follows these rules. They are enforced by shared code in `apps/api/src/common` and
covered by `apps/api/test/api-foundation.e2e-spec.ts`.

- **Base URL:** `/api/v1` (for example `http://localhost:3000/api/v1`).
- **Interactive docs:** `/api/docs` (Swagger UI); machine-readable OpenAPI at `/api/docs-json`.
- **Format:** JSON request and response bodies, UTF-8. Request bodies are limited to 100 KB;
  files go directly to object storage, not through the API.
- **Time:** ISO 8601 strings in UTC (`2026-11-20T07:00:00.000Z`).
- **Money:** integers in paise with a `currency` code (`"INR"`). Never floats.
- **Ids:** UUID strings.

## Endpoints implemented so far

| Method | Path                   | Auth   | Description                                                              |
| ------ | ---------------------- | ------ | ------------------------------------------------------------------------ |
| GET    | `/api/v1/health/live`  | Public | Liveness. 200 while the process runs. Never checks dependencies.         |
| GET    | `/api/v1/health/ready` | Public | Readiness. 200 when PostgreSQL, PostGIS and Redis are up; 503 otherwise. |
| GET    | `/api/v1/health`       | Public | Alias of `/health/ready` (used by the mobile and admin apps).            |
| GET    | `/api/docs`            | Public | Swagger UI.                                                              |

### Authentication (`/api/v1/auth`)

| Method | Path                         | Auth   | Success | Description                                                            |
| ------ | ---------------------------- | ------ | ------- | ---------------------------------------------------------------------- |
| GET    | `/auth/methods`              | Public | 200     | Which sign-in methods this server has configured.                      |
| POST   | `/auth/register`             | Public | 202     | Email, password, username, display name. Same reply if email exists.   |
| POST   | `/auth/login`                | Public | 200     | Email + password → tokens. One generic 401 for every failure.          |
| POST   | `/auth/refresh`              | Public | 200     | Rotates the refresh token. Reusing an old one signs out that device.   |
| POST   | `/auth/logout`               | Bearer | 204     | Signs out this device.                                                 |
| POST   | `/auth/logout-all`           | Bearer | 204     | Signs out every device.                                                |
| POST   | `/auth/otp/request`          | Public | 202     | Texts a 6-digit code. 503 when no SMS provider is configured.          |
| POST   | `/auth/otp/verify`           | Public | 200     | `AUTHENTICATED` with tokens, or `SIGNUP_REQUIRED` with a signup token. |
| POST   | `/auth/social/:provider`     | Public | 200     | `google` or `apple` ID token. Same result shape as OTP verify.         |
| POST   | `/auth/signup/complete`      | Public | 201     | Signup token + username + display name → tokens.                       |
| POST   | `/auth/email/verify/request` | Bearer | 202     | Sends a new verification link.                                         |
| POST   | `/auth/email/verify`         | Public | 204     | Confirms the email with the link token.                                |
| POST   | `/auth/password/forgot`      | Public | 202     | Emails a reset link (1 hour). Same reply if the account is unknown.    |
| POST   | `/auth/password/reset`       | Public | 204     | New password with the link token. Signs out every device.              |
| POST   | `/auth/password/change`      | Bearer | 204     | Current + new password. Signs out other devices.                       |

### Profiles

| Method | Path                  | Auth   | Description                                                                  |
| ------ | --------------------- | ------ | ---------------------------------------------------------------------------- |
| GET    | `/me`                 | Bearer | My profile, including my email, phone and verification status.               |
| PATCH  | `/me`                 | Bearer | Name, username, bio, city, country, languages. Other fields are ignored.     |
| GET    | `/me/preferences`     | Bearer | Travel preferences, profile visibility, messaging and notification settings. |
| PATCH  | `/me/preferences`     | Bearer | Partial update. Ranges are checked against stored values too.                |
| GET    | `/me/motorcycles`     | Bearer | My motorcycles, primary first.                                               |
| POST   | `/me/motorcycles`     | Bearer | Add (max 10). No registration numbers or documents are accepted.             |
| PATCH  | `/me/motorcycles/:id` | Bearer | Update. Another member's id returns 404.                                     |
| DELETE | `/me/motorcycles/:id` | Bearer | Remove. Another member's id returns 404.                                     |
| GET    | `/users/:username`    | Bearer | Public profile. Never contains email or phone. Blocked or inactive → 404.    |

Public profiles: `PUBLIC` shows the full public profile to signed-in members; `FOLLOWERS` shows it
to followers and the basics (name, username, verification badges) to others; `PRIVATE` shows only
the basics. Schemas: `PrivateProfileSchema`, `PublicProfileSchema` in `@voyago/shared`.

Health endpoints are not rate limited and not wrapped in `{ data }`, because load balancers and
orchestrators read them directly.

```json
// GET /api/v1/health/ready → 503
{
  "status": "degraded",
  "version": "0.1.0",
  "uptimeSeconds": 42,
  "timestamp": "2026-11-20T07:00:00.000Z",
  "checks": { "database": "up", "postgis": "up", "redis": "down" }
}
```

## Success responses

| Case              | Status | Body                                                                  |
| ----------------- | ------ | --------------------------------------------------------------------- |
| Read one resource | 200    | `{ "data": { ... } }`                                                 |
| Create            | 201    | `{ "data": { ... } }` (the created resource)                          |
| List              | 200    | `{ "data": [ ... ], "page": { "nextCursor": "…", "hasMore": true } }` |
| Action, no body   | 204    | empty                                                                 |

Types: `DataResponse<T>`, `PageResponse<T>` and the Zod builders `dataEnvelope` / `pageEnvelope`
in `@voyago/shared`.

## Errors

Every error, from validation to an unexpected crash, has the same shape (`ApiError` in
`@voyago/shared`):

```json
{
  "statusCode": 400,
  "error": "Bad Request",
  "message": "Validation failed",
  "details": [{ "path": "title", "message": "Too small: expected string to have >=3 characters" }],
  "requestId": "6c1f0a4e-7d0e-4c55-9a39-6b7e1f0c2d11",
  "timestamp": "2026-11-20T07:00:00.000Z",
  "path": "/api/v1/trips"
}
```

| Status | When                                                                                   |
| ------ | -------------------------------------------------------------------------------------- |
| 400    | Validation failed (`details` lists each field), malformed JSON, invalid cursor or UUID |
| 401    | Not authenticated (every route that is not explicitly public)                          |
| 403    | Authenticated but not allowed, or signing in to a suspended account                    |
| 404    | Route or record not found                                                              |
| 409    | Conflicts with existing data (duplicate, or related records prevent the change)        |
| 413    | Request body larger than 100 KB                                                        |
| 422    | Valid input that breaks a data rule enforced by the database                           |
| 429    | Rate limit exceeded                                                                    |
| 500    | Unexpected error. The message is always generic                                        |
| 503    | A dependency is down (readiness), or a provider is not configured (SMS, email, Google) |

**No internals leak.** Stack traces, SQL, table, column and constraint names never appear in
responses. Database errors are mapped by `AllExceptionsFilter`: unique violation → 409, foreign key
→ 409, record not found → 404, CHECK constraint or trigger rule → 422, anything else → generic 500.
The full error is logged server-side with the request id.

## Request ids

Every request gets an id, from a well-formed incoming `x-request-id` header (letters, digits, `_`,
`-`, up to 64 characters) or a new UUID. It is returned in the `x-request-id` response header, in
every error body and in every log line for that request. Quote it when reporting a problem.

## Validation

Request bodies, query strings and path parameters are validated with Zod schemas from
`@voyago/shared`, so the apps and the API share one definition.

```ts
// packages/shared: the contract
export const CreateThingSchema = z.object({ title: z.string().min(3).max(120) });

// apps/api: a DTO class from the same schema
export class CreateThingDto extends createZodDto(CreateThingSchema) {}

@Post()
create(@Body() body: CreateThingDto) { ... }          // validated by the global pipe

@Get(':id')
get(@Param('id', new ZodValidationPipe(UuidSchema)) id: string) { ... }
```

- The global `ZodValidationPipe` validates every parameter typed with a `createZodDto` class.
- Unknown properties are stripped, so clients cannot set fields they should not (`role`, `status`).
- Query values arrive as strings; schemas use `z.coerce` for numbers.
- The same schema generates the Swagger documentation for the DTO.

## Pagination

Lists use **cursor (keyset) pagination**, which stays fast and stable while new rows arrive (feeds,
chat, discovery).

| Query param | Type    | Default | Rules                                          |
| ----------- | ------- | ------- | ---------------------------------------------- |
| `limit`     | integer | 20      | 1 to 100                                       |
| `cursor`    | string  | none    | Opaque. Pass back `page.nextCursor` unchanged. |

The first request omits `cursor`. When `page.hasMore` is `false`, `nextCursor` is `null` and there
are no more results. A tampered cursor returns 400. Server side, use `CursorPageQuerySchema`,
`decodeCursor` and `toPage` from `src/common/pagination/cursor.ts`: fetch `limit + 1` rows ordered by
`(created_at DESC, id DESC)` and filter with the decoded cursor.

## Authentication

The API is **secure by default**. A global `AuthGuard` rejects every route with 401 unless it is
marked `@Public()`. Send `Authorization: Bearer <accessToken>`.

```json
// POST /api/v1/auth/login → 200
{
  "data": {
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…",
    "expiresIn": 900,
    "refreshToken": "q3V0…43 characters",
    "tokenType": "Bearer"
  }
}
```

- **Access token:** HS256 JWT, 15 minutes (`ACCESS_TOKEN_TTL_SECONDS`). Claims `sub` (user id) and
  `sid` (session family). The guard also checks on every request that the session is still signed
  in and the account is active, so logout and suspension take effect at once.
- **Refresh token:** opaque, 30 days (`REFRESH_TOKEN_TTL_DAYS`), single use. Each refresh returns
  a new pair; store the new refresh token. Presenting an already-used refresh token revokes that
  sign-in on every device that shares it (theft detection), so apps must not refresh in parallel.
- Mobile keeps the refresh token in the Keychain / Keystore and the access token in memory.
- On 401 from a protected route, refresh once and retry; if refresh returns 401, sign in again.
- Phone and social sign-ins return `{ status: "SIGNUP_REQUIRED", signupToken }` for new people;
  finish with `POST /auth/signup/complete`. The signup token lasts 15 minutes.

## Rate limiting

A global limit per client IP (`RATE_LIMIT_MAX` requests per `RATE_LIMIT_TTL_SECONDS`, default 120 per
60 s) returns 429 when exceeded. Health probes are exempt. Sign-in, OTP and recovery routes have a
stricter limit: `AUTH_RATE_LIMIT_MAX` (default 10) per minute per IP for each route. In addition,
10 failed passwords lock that account's password sign-in for 15 minutes, and each phone number can
receive 3 codes per 15 minutes and 10 per day. Each code allows 5 attempts. Behind a load balancer, set
`TRUST_PROXY=true` so the real client IP is used.

## CORS and headers

Allowed browser origins come from `CORS_ORIGINS` (comma-separated). Helmet sets security headers;
`x-powered-by` is removed.

## Versioning

Breaking changes go to a new prefix (`/api/v2`) while `/api/v1` keeps working for released mobile
apps. Additive changes (new fields, new endpoints) stay in v1.
