-- CreateEnum
CREATE TYPE "OperatorCategory" AS ENUM ('TOUR_OPERATOR', 'GUIDED_RIDES', 'TREKKING', 'ADVENTURE_ACTIVITIES', 'CAMPING_AND_STAYS', 'OTHER');

-- AlterTable
ALTER TABLE "commercial_operators" ADD COLUMN     "address_line1" VARCHAR(200),
ADD COLUMN     "address_line2" VARCHAR(200),
ADD COLUMN     "category" "OperatorCategory" NOT NULL DEFAULT 'OTHER',
ADD COLUMN     "city" VARCHAR(80),
ADD COLUMN     "country" CHAR(2) NOT NULL DEFAULT 'IN',
ADD COLUMN     "description" VARCHAR(2000),
ADD COLUMN     "postal_code" VARCHAR(10),
ADD COLUMN     "state" VARCHAR(80),
ADD COLUMN     "terms_accepted_at" TIMESTAMPTZ(3),
ADD COLUMN     "terms_version" VARCHAR(20),
ADD COLUMN     "website" VARCHAR(200);

-- Existing operators are backfilled as OTHER; new ones must choose a category.
ALTER TABLE "commercial_operators" ALTER COLUMN "category" DROP DEFAULT;

-- AlterTable
ALTER TABLE "commercial_packages" ADD COLUMN     "ends_at" TIMESTAMPTZ(3),
ADD COLUMN     "image_keys" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "meeting_point" geography(Point, 4326),
ADD COLUMN     "meeting_point_name" VARCHAR(160),
ADD COLUMN     "starts_at" TIMESTAMPTZ(3),
ADD COLUMN     "suspended_reason" VARCHAR(1000),
ADD COLUMN     "view_count" INTEGER NOT NULL DEFAULT 0;

-- Published packages from before this milestone have no dates or meeting point; they go back
-- to draft until their operator completes them.
UPDATE "commercial_packages" SET "status" = 'DRAFT'
  WHERE "status" = 'PUBLISHED'
    AND ("starts_at" IS NULL OR "ends_at" IS NULL OR "meeting_point_name" IS NULL
         OR cardinality("inclusions") = 0);

-- CreateTable
CREATE TABLE "package_questions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "package_id" UUID NOT NULL,
    "asker_id" UUID NOT NULL,
    "question" VARCHAR(500) NOT NULL,
    "answer" VARCHAR(1000),
    "answered_at" TIMESTAMPTZ(3),
    "answered_by_id" UUID,
    "hidden_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "package_questions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "package_questions_package_id_created_at_idx" ON "package_questions"("package_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "package_questions_asker_id_idx" ON "package_questions"("asker_id");

-- CreateIndex
CREATE INDEX "commercial_packages_status_starts_at_idx" ON "commercial_packages"("status", "starts_at");

-- AddForeignKey
ALTER TABLE "package_questions" ADD CONSTRAINT "package_questions_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "commercial_packages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "package_questions" ADD CONSTRAINT "package_questions_asker_id_fkey" FOREIGN KEY ("asker_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "package_questions" ADD CONSTRAINT "package_questions_answered_by_id_fkey" FOREIGN KEY ("answered_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ── Checks ──────────────────────────────────────────────────────────────────
ALTER TABLE "commercial_operators"
  ADD CONSTRAINT "commercial_operators_country_format" CHECK ("country" ~ '^[A-Z]{2}$'),
  ADD CONSTRAINT "commercial_operators_postal_code" CHECK (
    "postal_code" IS NULL OR "country" <> 'IN' OR "postal_code" ~ '^[1-9][0-9]{5}$'),
  ADD CONSTRAINT "commercial_operators_terms" CHECK (
    ("terms_accepted_at" IS NULL) = ("terms_version" IS NULL));

-- A listing shows its dates, meeting point, inclusions and cancellation terms before anyone
-- can book, so a published package must have all of them.
ALTER TABLE "commercial_packages"
  ADD CONSTRAINT "commercial_packages_dates" CHECK (
    "ends_at" IS NULL OR ("starts_at" IS NOT NULL AND "ends_at" >= "starts_at")),
  ADD CONSTRAINT "commercial_packages_published_complete" CHECK (
    "status" <> 'PUBLISHED' OR (
      "starts_at" IS NOT NULL AND "ends_at" IS NOT NULL AND "meeting_point_name" IS NOT NULL
      AND btrim("cancellation_policy") <> '' AND cardinality("inclusions") >= 1)),
  ADD CONSTRAINT "commercial_packages_price_max" CHECK ("price_paise" <= 100000000),
  ADD CONSTRAINT "commercial_packages_group_size_max" CHECK ("max_group_size" <= 200),
  ADD CONSTRAINT "commercial_packages_images_max" CHECK (cardinality("image_keys") <= 8),
  ADD CONSTRAINT "commercial_packages_view_count" CHECK ("view_count" >= 0),
  ADD CONSTRAINT "commercial_packages_suspended_reason" CHECK (
    ("status" = 'SUSPENDED') = ("suspended_reason" IS NOT NULL));

ALTER TABLE "package_questions"
  ADD CONSTRAINT "package_questions_question_present" CHECK (btrim("question") <> ''),
  ADD CONSTRAINT "package_questions_answered" CHECK (
    ("answer" IS NULL) = ("answered_at" IS NULL));
