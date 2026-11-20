-- Milestone 05: trip lifecycle.

-- New lifecycle states. (Not used elsewhere in this migration: PostgreSQL forbids using a new
-- enum value in the same transaction that adds it.)
ALTER TYPE "TripStatus" ADD VALUE 'FULL';
ALTER TYPE "TripStatus" ADD VALUE 'EXPIRED';

-- The spec names the non-public visibility PRIVATE. Renaming keeps any existing rows.
ALTER TYPE "TripVisibility" RENAME VALUE 'INVITE_ONLY' TO 'PRIVATE';

-- AlterTable
ALTER TABLE "trips" ADD COLUMN     "completed_at" TIMESTAMPTZ(3),
ADD COLUMN     "estimated_duration_minutes" INTEGER,
ADD COLUMN     "started_at" TIMESTAMPTZ(3);

-- ─────────────────────────────────────────────────────────────────────────────
-- Hand-written constraints
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "trips"
  -- Organiser's estimate; at most 60 days.
  ADD CONSTRAINT "trips_duration_range" CHECK (
    "estimated_duration_minutes" IS NULL OR "estimated_duration_minutes" BETWEEN 1 AND 86400),
  ADD CONSTRAINT "trips_cancelled_has_timestamp" CHECK (
    ("status" = 'CANCELLED') = ("cancelled_at" IS NOT NULL)),
  ADD CONSTRAINT "trips_completed_has_timestamp" CHECK (
    ("status" = 'COMPLETED') = ("completed_at" IS NOT NULL)),
  ADD CONSTRAINT "trips_started_has_timestamp" CHECK (
    "status" NOT IN ('IN_PROGRESS', 'COMPLETED') OR "started_at" IS NOT NULL),
  ADD CONSTRAINT "trips_title_not_blank" CHECK (char_length(btrim("title")) >= 3);

-- At most 25 stops per trip is enforced in the API; positions stay positive (initial schema).
