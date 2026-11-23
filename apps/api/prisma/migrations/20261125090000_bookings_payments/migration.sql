-- CreateEnum
CREATE TYPE "CancellationActor" AS ENUM ('CUSTOMER', 'OPERATOR', 'ADMIN', 'SYSTEM');

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('PENDING', 'PROCESSED', 'FAILED');

-- CreateEnum
CREATE TYPE "LedgerEntryKind" AS ENUM ('GROSS', 'COMMISSION', 'COMMISSION_TAX', 'PROVIDER_FEE', 'PROVIDER_FEE_TAX', 'OPERATOR_PAYABLE', 'REFUND', 'COMMISSION_REVERSAL', 'COMMISSION_TAX_REVERSAL', 'OPERATOR_PAYABLE_REVERSAL');

-- AlterTable: new booking columns. Rows from before this milestone (none in practice: booking
-- was closed) are backfilled, then the defaults are dropped so the API must set every value.
ALTER TABLE "bookings" ADD COLUMN     "cancellation_policy" VARCHAR(2000) NOT NULL DEFAULT '',
ADD COLUMN     "cancelled_by" "CancellationActor",
ADD COLUMN     "commission_bps" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "commission_paise" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "commission_tax_bps" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "commission_tax_paise" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "confirmed_at" TIMESTAMPTZ(3),
ADD COLUMN     "expires_at" TIMESTAMPTZ(3),
ADD COLUMN     "idempotency_key" VARCHAR(100),
ADD COLUMN     "operator_payable_paise" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "refund_tiers" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "refunded_amount_paise" INTEGER NOT NULL DEFAULT 0;

UPDATE "bookings" b SET
  "idempotency_key" = 'legacy-' || b."id"::text,
  "operator_payable_paise" = b."total_amount_paise",
  "cancellation_policy" = p."cancellation_policy",
  "expires_at" = CASE WHEN b."status" = 'PENDING_PAYMENT' THEN b."created_at" ELSE NULL END,
  "confirmed_at" = CASE WHEN b."status" IN ('CONFIRMED', 'COMPLETED') THEN b."updated_at" ELSE NULL END
FROM "commercial_packages" p WHERE p."id" = b."package_id";

ALTER TABLE "bookings"
  ALTER COLUMN "idempotency_key" SET NOT NULL,
  ALTER COLUMN "cancellation_policy" DROP DEFAULT,
  ALTER COLUMN "commission_bps" DROP DEFAULT,
  ALTER COLUMN "commission_paise" DROP DEFAULT,
  ALTER COLUMN "commission_tax_bps" DROP DEFAULT,
  ALTER COLUMN "commission_tax_paise" DROP DEFAULT,
  ALTER COLUMN "operator_payable_paise" DROP DEFAULT;

-- AlterTable
ALTER TABLE "commercial_packages" ADD COLUMN     "refund_tiers" JSONB NOT NULL DEFAULT '[]';

-- A published package now needs a refund schedule; ones without go back to draft.
UPDATE "commercial_packages" SET "status" = 'DRAFT'
  WHERE "status" = 'PUBLISHED' AND jsonb_array_length("refund_tiers") = 0;

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "method" VARCHAR(30),
ADD COLUMN     "provider_fee_paise" INTEGER,
ADD COLUMN     "provider_tax_paise" INTEGER;

-- CreateTable
CREATE TABLE "refunds" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "booking_id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "amount_paise" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "status" "RefundStatus" NOT NULL DEFAULT 'PENDING',
    "initiator" "CancellationActor" NOT NULL,
    "requested_by_id" UUID,
    "reason" VARCHAR(500),
    "hours_before" INTEGER,
    "refund_percent" SMALLINT,
    "provider" VARCHAR(40) NOT NULL,
    "provider_refund_id" VARCHAR(100),
    "idempotency_key" VARCHAR(100) NOT NULL,
    "failure_reason" VARCHAR(500),
    "processed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_entries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "booking_id" UUID NOT NULL,
    "operator_id" UUID NOT NULL,
    "payment_id" UUID,
    "refund_id" UUID,
    "kind" "LedgerEntryKind" NOT NULL,
    "amount_paise" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'INR',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "provider" VARCHAR(40) NOT NULL,
    "event_id" VARCHAR(120) NOT NULL,
    "event_type" VARCHAR(60) NOT NULL,
    "booking_id" UUID,
    "signature_valid" BOOLEAN NOT NULL,
    "summary" JSONB NOT NULL,
    "result" VARCHAR(300),
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(3),

    CONSTRAINT "payment_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "refunds_idempotency_key_key" ON "refunds"("idempotency_key");

-- CreateIndex
CREATE INDEX "refunds_booking_id_idx" ON "refunds"("booking_id");

-- CreateIndex
CREATE INDEX "refunds_status_idx" ON "refunds"("status");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_provider_provider_refund_id_key" ON "refunds"("provider", "provider_refund_id");

-- CreateIndex
CREATE INDEX "ledger_entries_booking_id_idx" ON "ledger_entries"("booking_id");

-- CreateIndex
CREATE INDEX "ledger_entries_operator_id_created_at_idx" ON "ledger_entries"("operator_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_entries_payment_id_kind_key" ON "ledger_entries"("payment_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_entries_refund_id_kind_key" ON "ledger_entries"("refund_id", "kind");

-- CreateIndex
CREATE INDEX "payment_events_booking_id_idx" ON "payment_events"("booking_id");

-- CreateIndex
CREATE INDEX "payment_events_received_at_idx" ON "payment_events"("received_at");

-- CreateIndex
CREATE UNIQUE INDEX "payment_events_provider_event_id_key" ON "payment_events"("provider", "event_id");

-- CreateIndex
CREATE INDEX "bookings_status_expires_at_idx" ON "bookings"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "bookings_user_id_idempotency_key_key" ON "bookings"("user_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "payments_provider_provider_order_id_key" ON "payments"("provider", "provider_order_id");

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "commercial_operators"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_refund_id_fkey" FOREIGN KEY ("refund_id") REFERENCES "refunds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE SET NULL ON UPDATE CASCADE;



-- ── Checks ──────────────────────────────────────────────────────────────────

ALTER TABLE "commercial_packages"
  ADD CONSTRAINT "commercial_packages_refund_tiers_shape" CHECK (
    jsonb_typeof("refund_tiers") = 'array' AND jsonb_array_length("refund_tiers") <= 6),
  DROP CONSTRAINT "commercial_packages_published_complete",
  ADD CONSTRAINT "commercial_packages_published_complete" CHECK (
    "status" <> 'PUBLISHED' OR (
      "starts_at" IS NOT NULL AND "ends_at" IS NOT NULL AND "meeting_point_name" IS NOT NULL
      AND btrim("cancellation_policy") <> '' AND cardinality("inclusions") >= 1
      AND jsonb_array_length("refund_tiers") >= 1));

ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_seats_max" CHECK ("seats" <= 10),
  ADD CONSTRAINT "bookings_commission_rates" CHECK (
    "commission_bps" BETWEEN 0 AND 10000 AND "commission_tax_bps" BETWEEN 0 AND 10000),
  ADD CONSTRAINT "bookings_split_matches" CHECK (
    "commission_paise" >= 0 AND "commission_tax_paise" >= 0 AND "operator_payable_paise" >= 0
    AND "operator_payable_paise" + "commission_paise" + "commission_tax_paise"
        = "total_amount_paise" - "platform_fee_paise"),
  ADD CONSTRAINT "bookings_refund_within_total" CHECK (
    "refunded_amount_paise" >= 0 AND "refunded_amount_paise" <= "total_amount_paise"),
  ADD CONSTRAINT "bookings_pending_expires" CHECK (
    "status" <> 'PENDING_PAYMENT' OR "expires_at" IS NOT NULL),
  ADD CONSTRAINT "bookings_confirmed_at" CHECK (
    "status" NOT IN ('CONFIRMED', 'COMPLETED') OR "confirmed_at" IS NOT NULL),
  ADD CONSTRAINT "bookings_cancelled_consistent" CHECK (
    ("cancelled_at" IS NULL) = ("cancelled_by" IS NULL)),
  ADD CONSTRAINT "bookings_refund_tiers_shape" CHECK (jsonb_typeof("refund_tiers") = 'array');

-- One unpaid hold per member and package.
CREATE UNIQUE INDEX "bookings_one_pending_per_package" ON "bookings" ("user_id", "package_id")
  WHERE "status" = 'PENDING_PAYMENT';

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_provider_fees_non_negative" CHECK (
    ("provider_fee_paise" IS NULL OR "provider_fee_paise" >= 0)
    AND ("provider_tax_paise" IS NULL OR "provider_tax_paise" >= 0)),
  ADD CONSTRAINT "payments_captured_at" CHECK (
    "status" NOT IN ('CAPTURED', 'REFUNDED', 'PARTIALLY_REFUNDED') OR "captured_at" IS NOT NULL);

ALTER TABLE "refunds"
  ADD CONSTRAINT "refunds_amount_positive" CHECK ("amount_paise" > 0),
  ADD CONSTRAINT "refunds_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "refunds_percent_range" CHECK (
    "refund_percent" IS NULL OR "refund_percent" BETWEEN 0 AND 100),
  ADD CONSTRAINT "refunds_processed_at" CHECK (
    ("status" = 'PROCESSED') = ("processed_at" IS NOT NULL)),
  ADD CONSTRAINT "refunds_failure_reason" CHECK (
    "status" <> 'FAILED' OR "failure_reason" IS NOT NULL);

ALTER TABLE "ledger_entries"
  ADD CONSTRAINT "ledger_entries_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT "ledger_entries_source" CHECK (
    ("payment_id" IS NOT NULL)::int + ("refund_id" IS NOT NULL)::int = 1),
  ADD CONSTRAINT "ledger_entries_sign" CHECK (
    CASE WHEN "kind" IN ('REFUND', 'COMMISSION_REVERSAL', 'COMMISSION_TAX_REVERSAL',
                         'OPERATOR_PAYABLE_REVERSAL')
         THEN "amount_paise" <= 0 ELSE "amount_paise" >= 0 END);

-- ── Capacity: never sell more places than the package has ──────────────────
-- Holding bookings (awaiting payment or confirmed) are counted with the package row locked, so two
-- checkouts racing for the last place cannot both succeed.
CREATE FUNCTION "bookings_enforce_capacity"() RETURNS trigger AS $$
DECLARE
  capacity integer;
  held integer;
BEGIN
  IF NEW."status" NOT IN ('PENDING_PAYMENT', 'CONFIRMED') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."status" IN ('PENDING_PAYMENT', 'CONFIRMED')
     AND NEW."seats" <= OLD."seats" AND NEW."package_id" = OLD."package_id" THEN
    RETURN NEW;
  END IF;
  SELECT "max_group_size" INTO capacity FROM "commercial_packages"
    WHERE "id" = NEW."package_id" FOR UPDATE;
  SELECT COALESCE(SUM("seats"), 0) INTO held FROM "bookings"
    WHERE "package_id" = NEW."package_id" AND "id" <> NEW."id"
      AND "status" IN ('PENDING_PAYMENT', 'CONFIRMED');
  IF held + NEW."seats" > capacity THEN
    RAISE EXCEPTION 'Not enough places left on this package'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'bookings_capacity';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "bookings_enforce_capacity"
  BEFORE INSERT OR UPDATE OF "status", "seats", "package_id" ON "bookings"
  FOR EACH ROW EXECUTE FUNCTION "bookings_enforce_capacity"();

-- ── The ledger is append-only ───────────────────────────────────────────────
-- Corrections are new entries. Deleting is only possible in a maintenance session that sets
-- voyago.ledger_maintenance = 'on' (test clean-up, retention tooling); the API never does.
CREATE FUNCTION "ledger_entries_append_only"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('voyago.ledger_maintenance', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'ledger_entries is append-only (% not allowed)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ledger_entries_append_only"
  BEFORE UPDATE OR DELETE ON "ledger_entries"
  FOR EACH ROW EXECUTE FUNCTION "ledger_entries_append_only"();
