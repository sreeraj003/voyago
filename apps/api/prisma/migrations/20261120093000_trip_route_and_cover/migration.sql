-- AlterTable
ALTER TABLE "trips" ADD COLUMN     "route_computed_at" TIMESTAMPTZ(3),
ADD COLUMN     "route_distance_meters" INTEGER,
ADD COLUMN     "route_duration_seconds" INTEGER,
ADD COLUMN     "route_travel_mode" VARCHAR(20);

-- ─────────────────────────────────────────────────────────────────────────────
-- Hand-written constraints
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE "trips"
  -- The route columns are set together or not at all.
  ADD CONSTRAINT "trips_route_complete" CHECK (
    ("route_distance_meters" IS NULL) = ("route_duration_seconds" IS NULL) AND
    ("route_distance_meters" IS NULL) = ("route_travel_mode" IS NULL) AND
    ("route_distance_meters" IS NULL) = ("route_computed_at" IS NULL)),
  ADD CONSTRAINT "trips_route_values" CHECK (
    ("route_distance_meters" IS NULL OR "route_distance_meters" >= 0) AND
    ("route_duration_seconds" IS NULL OR "route_duration_seconds" >= 0) AND
    ("route_travel_mode" IS NULL OR "route_travel_mode" IN ('TWO_WHEELER', 'DRIVE'))),
  -- Cover images are Cloudinary public ids inside a trip-covers folder, never URLs.
  ADD CONSTRAINT "trips_cover_image_key_format" CHECK (
    "cover_image_key" IS NULL OR "cover_image_key" ~ '^[a-z0-9_-]{1,40}/trip-covers/[0-9a-f-]{36}/[0-9a-f-]{36}$');
