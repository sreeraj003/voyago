-- CreateEnum
CREATE TYPE "AnalyticsEventName" AS ENUM ('account_registered', 'profile_completed', 'trip_created', 'trip_published', 'trip_viewed', 'join_requested', 'join_approved', 'trip_started', 'trip_completed', 'trip_cancelled', 'community_joined', 'booking_started', 'booking_confirmed', 'subscription_started', 'user_active');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "profile_completed_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "analytics_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" "AnalyticsEventName" NOT NULL,
    "actor_key" CHAR(32),
    "properties" JSONB NOT NULL DEFAULT '{}',
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analytics_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_runs" (
    "name" VARCHAR(60) NOT NULL,
    "last_started_at" TIMESTAMPTZ(3),
    "last_success_at" TIMESTAMPTZ(3),
    "last_error" VARCHAR(500),
    "last_error_at" TIMESTAMPTZ(3),
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "runs" INTEGER NOT NULL DEFAULT 0,
    "failures" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "job_runs_pkey" PRIMARY KEY ("name")
);

-- CreateIndex
CREATE INDEX "analytics_events_name_occurred_at_idx" ON "analytics_events"("name", "occurred_at");

-- CreateIndex
CREATE INDEX "analytics_events_actor_key_occurred_at_idx" ON "analytics_events"("actor_key", "occurred_at");

-- CreateIndex
CREATE INDEX "analytics_events_occurred_at_idx" ON "analytics_events"("occurred_at");


-- ── Checks (milestone 15) ──────────────────────────────────────────────────
-- Events hold a few whitelisted properties, never free text or coordinates; keep them small.
ALTER TABLE "analytics_events"
  ADD CONSTRAINT "analytics_events_properties_object" CHECK (jsonb_typeof("properties") = 'object'),
  ADD CONSTRAINT "analytics_events_properties_small" CHECK (octet_length("properties"::text) <= 1024),
  ADD CONSTRAINT "analytics_events_actor_key_format" CHECK ("actor_key" IS NULL OR "actor_key" ~ '^[0-9a-f]{32}$');

ALTER TABLE "job_runs"
  ADD CONSTRAINT "job_runs_counts" CHECK (
    "runs" >= 0 AND "failures" >= 0 AND "failures" <= "runs" AND "consecutive_failures" >= 0);

-- Profiles already filled in count as completed (no event is recorded for them).
UPDATE "users" u SET "profile_completed_at" = u."updated_at"
WHERE u."bio" IS NOT NULL AND u."bio" <> '' AND u."home_city" IS NOT NULL AND cardinality(u."languages") > 0
  AND EXISTS (SELECT 1 FROM "user_preferences" p WHERE p."user_id" = u."id" AND cardinality(p."interests") > 0);
