# 04 --- Authentication, Accounts and User Profiles

Implement secure account registration and profile management.

## Authentication

Support: - Phone OTP flow through a provider adapter. - Email/password
only if selected for the initial release. - Google and Apple sign-in
through provider adapters when credentials are configured. - Short-lived
access tokens. - Rotating refresh tokens. - Logout and refresh-token
revocation. - Account recovery and verification status.

Do not pretend OTP or social login works when provider credentials are
absent. Provide a development-only OTP adapter that is impossible to
enable in production.

## User profile

Fields: - full name - unique username - email and phone (private) -
profile image - bio - city and country - languages - interests - travel
preferences - account status - verification status

Date of birth and gender should be optional and collected only if there
is a clear product/legal need. Do not expose private contact details
publicly.

## Preferences

-   preferred activities
-   budget range
-   group-size preference
-   preferred destinations
-   languages
-   travel style

## Motorcycle profile

Optional: - manufacturer - model - engine capacity - category - riding
experience - verification status

Do not publicly expose registration documents or vehicle identifiers.

## Security

-   Hash passwords using Argon2id or a suitably configured alternative.
-   Store refresh tokens securely (hashed server-side where practical).
-   Rate-limit OTP and login attempts.
-   Prevent account enumeration.
-   Validate all input server-side.
-   Add authorization tests.
-   Keep secrets in environment variables.

## Deliverables

-   Auth endpoints and services.
-   User profile endpoints.
-   Preference endpoints.
-   Motorcycle profile endpoints.
-   Mobile registration/login/profile screens.
-   Tests for login, refresh, logout, ownership and privacy.

## Completion gate

A user can register, authenticate, refresh a session, log out and update
a profile. Public profile responses do not leak private data. Tests pass
and docs are updated.
