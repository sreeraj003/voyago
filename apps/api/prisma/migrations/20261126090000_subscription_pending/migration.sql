-- A subscription created at the provider and waiting for its first payment. Kept in its own
-- migration: Postgres can't use a new enum value in the transaction that adds it.
ALTER TYPE "SubscriptionStatus" ADD VALUE 'PENDING' BEFORE 'TRIALING';
