# 0007: Authentication and sessions

- Status: Accepted
- Date: 2026-11-20

## Context

Milestone 04 needs sign-in for a mobile-first app in India, with short-lived access, revocable
sessions and no account enumeration. The person chose phone OTP and email + password for launch.
Google and Apple must work only when credentials are configured.

## Decision

- **Access tokens** are HS256 JWTs (jose), 15 minutes, carrying the user id and a session family
  id. The guard also checks the session family and account status in the database per request.
  This costs one indexed query per request but makes logout and suspension immediate. It can be
  cached in Redis later if needed.
- **Refresh tokens** are opaque 256-bit random strings, stored as SHA-256 hashes in
  `auth_sessions`, rotated on every use. A reused rotated token revokes the whole family
  (OAuth 2.0 Security BCP, refresh token rotation).
- **Passwords** use Argon2id (`@node-rs/argon2`, OWASP baseline parameters).
- **OTP codes** are HMAC-SHA-256 with a server secret, 5 minutes, 5 attempts, per-number limits.
- **Delivery providers** sit behind `SmsSender` / `EmailSender` interfaces. Only `none` and a
  development adapter exist; the development adapter is rejected in production twice (env schema
  and constructor). Real providers are added once accounts and credentials exist.
- **Social sign-in** verifies provider ID tokens against their JWKS with the configured client ids
  as audience. Accounts link by provider subject; automatic linking by email only when both sides
  have verified it.

## Consequences

- No third-party auth service and no vendor lock-in; we own security-sensitive code, covered by
  e2e tests.
- Strict rotation means two parallel refreshes from the same app sign it out; the mobile client
  makes refreshes single-flight.
- Phone sign-in in production waits for an SMS provider with DLT registration.
