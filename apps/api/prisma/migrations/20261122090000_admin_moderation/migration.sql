-- Milestone 10: admin dashboard and moderation.

-- ── Staff roles ─────────────────────────────────────────────────────────────
-- ADMIN becomes SUPER_ADMIN (existing admins keep full access); SUPPORT and OPERATIONS are new.
ALTER TYPE "UserRole" RENAME VALUE 'ADMIN' TO 'SUPER_ADMIN';
ALTER TYPE "UserRole" ADD VALUE 'SUPPORT';
ALTER TYPE "UserRole" ADD VALUE 'OPERATIONS';

-- ── Reports: severity and evidence references ──────────────────────────────
CREATE TYPE "ReportSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

ALTER TABLE "reports"
  ADD COLUMN "evidence_refs" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "severity" "ReportSeverity" NOT NULL DEFAULT 'MEDIUM';

-- Existing reports get the same starting severity new ones get (defaultReportSeverity).
UPDATE "reports" SET "severity" = CASE
  WHEN "reason"::text IN ('UNSAFE_BEHAVIOUR', 'SCAM_OR_FRAUD', 'ILLEGAL_TRANSPORT') THEN 'HIGH'::"ReportSeverity"
  WHEN "reason"::text IN ('SPAM', 'OTHER') THEN 'LOW'::"ReportSeverity"
  ELSE 'MEDIUM'::"ReportSeverity"
END;

ALTER TABLE "reports" ADD CONSTRAINT "reports_evidence_refs_count"
  CHECK ("evidence_refs" IS NULL OR cardinality("evidence_refs") <= 20);
-- Resolved reports always carry a resolution time; unresolved ones never do.
UPDATE "reports" SET "resolved_at" = "updated_at"
  WHERE "status"::text IN ('ACTIONED', 'DISMISSED') AND "resolved_at" IS NULL;
UPDATE "reports" SET "resolved_at" = NULL
  WHERE "status"::text IN ('OPEN', 'IN_REVIEW') AND "resolved_at" IS NOT NULL;
ALTER TABLE "reports" ADD CONSTRAINT "reports_resolution"
  CHECK (("status"::text IN ('ACTIONED', 'DISMISSED')) = ("resolved_at" IS NOT NULL));

-- The moderation queue: unresolved reports, most severe and oldest first.
CREATE INDEX "reports_queue_idx" ON "reports" ("severity" DESC, "created_at")
  WHERE "status" IN ('OPEN', 'IN_REVIEW');

-- ── Trips hidden by moderators ─────────────────────────────────────────────
ALTER TABLE "trips"
  ADD COLUMN "hidden_at" TIMESTAMPTZ(3),
  ADD COLUMN "hidden_by_id" UUID,
  ADD COLUMN "hidden_reason" VARCHAR(500);

ALTER TABLE "trips" ADD CONSTRAINT "trips_hidden_by_id_fkey" FOREIGN KEY ("hidden_by_id")
  REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "trips" ADD CONSTRAINT "trips_hidden_reason"
  CHECK (("hidden_at" IS NULL) = ("hidden_reason" IS NULL));

CREATE INDEX "trips_hidden_idx" ON "trips" ("hidden_at" DESC) WHERE "hidden_at" IS NOT NULL;

-- ── Operator verification documents ────────────────────────────────────────
CREATE TYPE "OperatorDocumentKind" AS ENUM (
  'BUSINESS_REGISTRATION', 'GST_CERTIFICATE', 'OWNER_ID', 'INSURANCE', 'TOURISM_LICENCE', 'OTHER'
);
CREATE TYPE "OperatorDocumentStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED');

ALTER TABLE "commercial_operators"
  ADD COLUMN "submitted_at" TIMESTAMPTZ(3),
  ADD COLUMN "verification_note" VARCHAR(1000);

-- Operators marked verified before this review workflow existed go back to the queue.
UPDATE "commercial_operators" SET "verification_status" = 'PENDING', "verified_at" = NULL
  WHERE "verification_status"::text = 'VERIFIED' AND ("verified_at" IS NULL OR "verified_by_id" IS NULL);

-- A verified operator always records who verified it and when (never automatic).
ALTER TABLE "commercial_operators" ADD CONSTRAINT "commercial_operators_verified_by"
  CHECK ("verification_status"::text <> 'VERIFIED' OR ("verified_at" IS NOT NULL AND "verified_by_id" IS NOT NULL));

CREATE TABLE "operator_documents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "operator_id" UUID NOT NULL,
    "kind" "OperatorDocumentKind" NOT NULL,
    "storage_key" TEXT NOT NULL,
    "format" VARCHAR(10) NOT NULL,
    "file_name" VARCHAR(200) NOT NULL,
    "status" "OperatorDocumentStatus" NOT NULL DEFAULT 'PENDING',
    "review_note" VARCHAR(1000),
    "reviewed_by_id" UUID,
    "reviewed_at" TIMESTAMPTZ(3),
    "uploaded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "operator_documents_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "operator_documents_storage_key_format"
      CHECK ("storage_key" ~ '^[a-z0-9_-]{1,40}/operator-docs/[0-9a-f-]{36}/[0-9a-f-]{36}$'),
    CONSTRAINT "operator_documents_format"
      CHECK ("format" IN ('pdf', 'jpg', 'jpeg', 'png', 'webp')),
    CONSTRAINT "operator_documents_review"
      CHECK (("status"::text = 'PENDING') = ("reviewed_at" IS NULL))
);

CREATE INDEX "operator_documents_operator_id_idx" ON "operator_documents"("operator_id");

ALTER TABLE "operator_documents" ADD CONSTRAINT "operator_documents_operator_id_fkey"
  FOREIGN KEY ("operator_id") REFERENCES "commercial_operators"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "operator_documents" ADD CONSTRAINT "operator_documents_reviewed_by_id_fkey"
  FOREIGN KEY ("reviewed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
