# 13 --- Bookings, Payments, Commissions and Refunds

Implement only after legal review, provider selection and operator
agreements.

## Provider evaluation

Evaluate Indian payment providers and their
marketplace/connected-account settlement capabilities. Confirm provider
eligibility, KYC requirements, settlement flow, refunds, chargebacks and
fees. Do not assume split settlement is available for every account.

## Booking flow

1.  User selects package and participant count.
2.  Backend locks/checks capacity.
3.  Create pending booking.
4.  Create payment order with provider.
5.  Client completes provider checkout.
6.  Verify provider signature server-side.
7.  Verify webhook signature.
8.  Process webhook idempotently.
9.  Confirm booking only after authoritative payment confirmation.
10. Notify user and operator.

## Money

-   Store amounts in integer minor units (paise).
-   Store currency explicitly.
-   Record gross amount, commission, provider fees where available,
    operator payable and tax fields as separate ledger entries.
-   Never use floating-point arithmetic for money.
-   Do not treat a frontend callback as proof of payment.

## Commission

Start with a configurable rate, not a hardcoded value. A 10% commission
may be used as an initial business assumption, subject to partner
contracts and validation.

## Idempotency and concurrency

-   Idempotency key for booking/payment creation.
-   Unique provider payment and webhook references.
-   Database transaction for booking confirmation and capacity.
-   Reconciliation process for delayed or conflicting webhooks.
-   Prevent overselling.

## Cancellation/refunds

-   Show policy before checkout.
-   Calculate refund based on the published policy.
-   Track refund pending/succeeded/failed.
-   Record every financial event.
-   Provide admin reconciliation tools.

## Security

-   Keep provider secrets server-side.
-   Verify signatures.
-   Validate amount and currency against the booking.
-   Never trust client-supplied commission.
-   Do not store card details.

## Tests

Simulate success, failure, duplicate webhook, delayed webhook, refund,
partial refund, overselling and reconciliation.

## Completion gate

End-to-end test payments in provider sandbox. Do not enable production
payments until legal, provider and operational approvals are complete.
