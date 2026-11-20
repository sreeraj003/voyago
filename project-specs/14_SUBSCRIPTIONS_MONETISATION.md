# 14 --- Subscriptions and Monetisation

Implement subscriptions only after users demonstrate repeat value.

## Proposed plans

Free: - create/join free community trips - basic discovery - basic
profile - core messaging - safety, blocking and reporting

Explorer Pro: - proposed ₹119/month - advanced discovery - saved
searches - enhanced travel statistics - additional profile
customisation - optional exclusive content

Organiser Pro: - proposed ₹699/month - organiser analytics - advanced
participant management - custom organiser profile - promotion credits -
trip performance insights

Prices are hypotheses. Make them configurable and validate willingness
to pay.

## Entitlements

Create backend-controlled entitlements. Never rely only on frontend
flags.

Support: - FREE - EXPLORER_PRO - ORGANISER_PRO

Track: - plan - provider reference - start/end dates - renewal state -
cancellation - payment status - entitlement status

## Rules

-   Core safety and basic communication remain free.
-   Expired subscriptions lose paid entitlements correctly.
-   Cancellation and refund rules are transparent.
-   Avoid dark patterns and accidental renewals.
-   Support provider webhook idempotency.

## Additional monetisation

Later support: - featured commercial experiences - clearly labelled
sponsored listings - affiliate referrals - brand partnerships

Do not insert unlabelled paid placement into organic discovery.

## Tests

Test activation, renewal, cancellation, expiry, failed payment,
duplicate webhook and entitlement enforcement.

## Completion gate

Subscription status and entitlements are server-authoritative and
tested. Update pricing and billing documentation.
