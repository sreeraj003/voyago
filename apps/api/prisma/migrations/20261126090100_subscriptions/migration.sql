-- Milestone 14: subscriptions, entitlements and the paid features.

CREATE TYPE "SubscriptionTier" AS ENUM ('EXPLORER_PRO', 'ORGANISER_PRO');

-- ── Plans ───────────────────────────────────────────────────────────────────
ALTER TABLE "subscription_plans"
  ADD COLUMN "provider_plan_id" VARCHAR(100),
  ADD COLUMN "provider_plan_price_paise" INTEGER,
  ADD COLUMN "tier" "SubscriptionTier";

UPDATE "subscription_plans"
SET "tier" = CASE WHEN "code" LIKE 'ORGANISER%' THEN 'ORGANISER_PRO' ELSE 'EXPLORER_PRO' END::"SubscriptionTier";

ALTER TABLE "subscription_plans"
  ALTER COLUMN "tier" SET NOT NULL,
  ADD CONSTRAINT "subscription_plans_price_min" CHECK ("price_paise" >= 100),
  ADD CONSTRAINT "subscription_plans_provider_plan" CHECK (
    ("provider_plan_id" IS NULL) = ("provider_plan_price_paise" IS NULL));

-- ── Subscriptions ───────────────────────────────────────────────────────────
ALTER TABLE "subscriptions"
  ADD COLUMN "cancellation_reason" VARCHAR(500),
  ADD COLUMN "currency" CHAR(3) NOT NULL DEFAULT 'INR',
  ADD COLUMN "ended_at" TIMESTAMPTZ(3),
  ADD COLUMN "idempotency_key" VARCHAR(100),
  ADD COLUMN "price_paise" INTEGER,
  ADD COLUMN "provider_status" VARCHAR(30),
  ADD COLUMN "reminded_for_period_end" TIMESTAMPTZ(3),
  ALTER COLUMN "status" SET DEFAULT 'PENDING',
  ALTER COLUMN "current_period_start" DROP NOT NULL,
  ALTER COLUMN "current_period_end" DROP NOT NULL;

-- No subscriptions were sold before this milestone; backfill any development rows.
UPDATE "subscriptions" s
SET "idempotency_key" = 'legacy-' || s."id"::text,
    "price_paise" = p."price_paise"
FROM "subscription_plans" p WHERE p."id" = s."plan_id";

ALTER TABLE "subscriptions"
  ALTER COLUMN "idempotency_key" SET NOT NULL,
  ALTER COLUMN "price_paise" SET NOT NULL,
  DROP CONSTRAINT "subscriptions_period_order",
  ADD CONSTRAINT "subscriptions_period_order" CHECK (
    "current_period_start" IS NULL OR "current_period_end" IS NULL
    OR "current_period_end" > "current_period_start"),
  ADD CONSTRAINT "subscriptions_period_when_paid" CHECK (
    "status" IN ('PENDING', 'EXPIRED', 'CANCELLED')
    OR ("current_period_start" IS NOT NULL AND "current_period_end" IS NOT NULL)),
  ADD CONSTRAINT "subscriptions_price_positive" CHECK ("price_paise" > 0),
  ADD CONSTRAINT "subscriptions_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "subscriptions_cancelled_at" CHECK (
    "status" <> 'CANCELLED' OR "cancelled_at" IS NOT NULL);

CREATE UNIQUE INDEX "subscriptions_user_id_idempotency_key_key"
  ON "subscriptions"("user_id", "idempotency_key");

-- One subscription in progress per member: waiting for payment, active or retrying a renewal.
DROP INDEX "subscriptions_one_live_per_user";
CREATE UNIQUE INDEX "subscriptions_one_live_per_user" ON "subscriptions" ("user_id")
  WHERE "status" IN ('PENDING', 'TRIALING', 'ACTIVE', 'PAST_DUE');

-- ── Provider events ─────────────────────────────────────────────────────────
ALTER TABLE "payment_events" ADD COLUMN "subscription_id" UUID;
CREATE INDEX "payment_events_subscription_id_idx" ON "payment_events"("subscription_id");
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_subscription_id_fkey"
  FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── Profile style (paid; hidden while the plan is not active) ───────────────
ALTER TABLE "users"
  ADD COLUMN "accent_color" VARCHAR(20),
  ADD COLUMN "profile_headline" VARCHAR(120),
  ADD CONSTRAINT "users_accent_color" CHECK ("accent_color" IS NULL OR "accent_color" IN
    ('teal', 'indigo', 'amber', 'rose', 'forest', 'slate', 'sunset', 'ocean')),
  ADD CONSTRAINT "users_profile_headline_present" CHECK (
    "profile_headline" IS NULL OR btrim("profile_headline") <> '');

-- ── Saved searches ──────────────────────────────────────────────────────────
CREATE TABLE "saved_searches" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "query" JSONB NOT NULL,
    "alerts" BOOLEAN NOT NULL DEFAULT false,
    "last_alerted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "saved_searches_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "saved_searches_name_present" CHECK (btrim("name") <> ''),
    CONSTRAINT "saved_searches_query_object" CHECK (jsonb_typeof("query") = 'object')
);
CREATE INDEX "saved_searches_alerts_idx" ON "saved_searches"("alerts");
CREATE UNIQUE INDEX "saved_searches_user_id_name_key" ON "saved_searches"("user_id", "name");
ALTER TABLE "saved_searches" ADD CONSTRAINT "saved_searches_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- At most 10 saved searches per member (SAVED_SEARCHES_MAX), even under parallel requests.
CREATE FUNCTION "saved_searches_enforce_max"() RETURNS trigger AS $$
BEGIN
  PERFORM 1 FROM "users" WHERE "id" = NEW."user_id" FOR UPDATE;
  IF (SELECT count(*) FROM "saved_searches" WHERE "user_id" = NEW."user_id") >= 10 THEN
    RAISE EXCEPTION 'At most 10 saved searches' USING ERRCODE = 'check_violation',
      CONSTRAINT = 'saved_searches_max';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "saved_searches_enforce_max" BEFORE INSERT ON "saved_searches"
  FOR EACH ROW EXECUTE FUNCTION "saved_searches_enforce_max"();
