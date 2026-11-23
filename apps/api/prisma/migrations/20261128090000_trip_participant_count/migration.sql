-- Milestone 16 (performance): a stored count of active participants on each trip.
-- Discovery ranks and filters by open places; counting participants for every candidate trip
-- on every search was the main cost under load. The count is kept by the database, so no code
-- path can forget it, and it is recounted (not incremented) so it can't drift.
ALTER TABLE "trips" ADD COLUMN "participant_count" SMALLINT NOT NULL DEFAULT 0;

UPDATE "trips" t SET "participant_count" = c.n
FROM (
  SELECT "trip_id", count(*) AS n FROM "trip_participants"
  WHERE "status" = 'ACTIVE' GROUP BY "trip_id"
) c
WHERE c."trip_id" = t."id";

CREATE FUNCTION "sync_trip_participant_count"() RETURNS trigger AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    UPDATE "trips" SET "participant_count" = (
      SELECT count(*) FROM "trip_participants"
      WHERE "trip_id" = OLD."trip_id" AND "status" = 'ACTIVE'
    ) WHERE "id" = OLD."trip_id";
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND (TG_OP = 'INSERT' OR NEW."trip_id" <> OLD."trip_id") THEN
    UPDATE "trips" SET "participant_count" = (
      SELECT count(*) FROM "trip_participants"
      WHERE "trip_id" = NEW."trip_id" AND "status" = 'ACTIVE'
    ) WHERE "id" = NEW."trip_id";
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "trip_participants_count"
  AFTER INSERT OR DELETE OR UPDATE OF "status", "trip_id" ON "trip_participants"
  FOR EACH ROW EXECUTE FUNCTION "sync_trip_participant_count"();
