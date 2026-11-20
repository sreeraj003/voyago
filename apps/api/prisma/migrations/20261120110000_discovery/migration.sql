-- Milestone 06: trip discovery and geospatial search.
-- Prisma cannot express generated columns, partial indexes or expression indexes; they are
-- written by hand here. Partial and expression indexes are invisible to Prisma's drift check.

CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- Rides only: bike types the ride suits. Empty means any bike is welcome.
ALTER TABLE "trips" ADD COLUMN "bike_categories" "MotorcycleCategory"[] DEFAULT ARRAY[]::"MotorcycleCategory"[];
ALTER TABLE "trips" ADD CONSTRAINT "trips_bike_categories_rides_only"
  CHECK ("mode" = 'RIDE' OR coalesce(cardinality("bike_categories"), 0) = 0);

-- Full-text search over what members type: title and place names weigh most, then description.
-- 'simple' configuration: no English stemming, which would mangle Indian place names.
ALTER TABLE "trips" ADD COLUMN "search_vector" tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('simple', coalesce("title", '')), 'A') ||
  setweight(to_tsvector('simple', coalesce("destination_name", '')), 'A') ||
  setweight(to_tsvector('simple', coalesce("origin_name", '')), 'B') ||
  setweight(to_tsvector('simple', coalesce("description", '')), 'C')
) STORED;
CREATE INDEX "trips_search_idx" ON "trips" USING GIN ("search_vector");

-- Place-name filters ("from", "to") match partial names, case-insensitively.
CREATE INDEX "trips_origin_name_trgm_idx" ON "trips" USING GIN (lower("origin_name") gin_trgm_ops);
CREATE INDEX "trips_destination_name_trgm_idx" ON "trips" USING GIN (lower("destination_name") gin_trgm_ops);

-- Only public, open, live trips are ever discoverable, so the discovery indexes cover just those.
CREATE INDEX "trips_discoverable_departure_idx" ON "trips" ("departure_at", "id")
  WHERE "visibility" = 'PUBLIC' AND "status" IN ('PUBLISHED', 'FULL') AND "deleted_at" IS NULL;
CREATE INDEX "trips_discoverable_origin_idx" ON "trips" USING GIST ("origin")
  WHERE "visibility" = 'PUBLIC' AND "status" IN ('PUBLISHED', 'FULL') AND "deleted_at" IS NULL;

-- Trending counts recent joins per trip.
CREATE INDEX "trip_participants_trip_id_joined_at_idx" ON "trip_participants" ("trip_id", "joined_at")
  WHERE "status" = 'ACTIVE';
