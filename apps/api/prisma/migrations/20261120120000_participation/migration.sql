-- Milestone 07: join requests and participant management.

-- Spec statuses. Join requests closed by the system (trip cancelled, expired or started) are
-- CANCELLED; EXPIRED was never used.
ALTER TYPE "JoinRequestStatus" RENAME VALUE 'EXPIRED' TO 'CANCELLED';
ALTER TYPE "ParticipantStatus" ADD VALUE IF NOT EXISTS 'COMPLETED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'PARTICIPANT_REMOVED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'TRIP_REMINDER';

-- Keep request history: a member may ask again after withdrawing or being declined, but only
-- one request per member and trip can be pending at a time.
DROP INDEX "trip_join_requests_trip_id_user_id_key";
CREATE UNIQUE INDEX "trip_join_requests_one_pending" ON "trip_join_requests" ("trip_id", "user_id")
  WHERE "status" = 'PENDING';
ALTER TABLE "trip_join_requests" ADD CONSTRAINT "trip_join_requests_decided_when_closed"
  CHECK (("status" = 'PENDING') = ("decided_at" IS NULL));

-- Removal is recorded on the row (and in audit_logs).
ALTER TABLE "trip_participants" ADD COLUMN "removal_reason" VARCHAR(500),
ADD COLUMN "removed_by_id" UUID;
ALTER TABLE "trip_participants" ADD CONSTRAINT "trip_participants_removed_by_id_fkey"
  FOREIGN KEY ("removed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "trip_participants" ADD CONSTRAINT "trip_participants_left_has_timestamp"
  CHECK (("status" IN ('LEFT', 'REMOVED')) = ("left_at" IS NOT NULL));
ALTER TABLE "trip_participants" ADD CONSTRAINT "trip_participants_reason_only_when_removed"
  CHECK ("removal_reason" IS NULL OR "status" = 'REMOVED');

ALTER TABLE "trips" ADD COLUMN "reminder_sent_at" TIMESTAMPTZ(3);

-- Capacity, enforced by the database as well as the API. Activating a participant locks the
-- trip row, so concurrent approvals queue behind each other and the count is always current.
CREATE FUNCTION "enforce_trip_capacity"() RETURNS trigger AS $$
DECLARE
  capacity integer;
  active integer;
BEGIN
  IF NEW."status" <> 'ACTIVE' OR (TG_OP = 'UPDATE' AND OLD."status" = 'ACTIVE') THEN
    RETURN NEW;
  END IF;
  SELECT "max_participants" INTO capacity FROM "trips" WHERE "id" = NEW."trip_id" FOR UPDATE;
  SELECT count(*) INTO active FROM "trip_participants"
    WHERE "trip_id" = NEW."trip_id" AND "status" = 'ACTIVE' AND "id" <> NEW."id";
  IF active >= capacity THEN
    RAISE EXCEPTION 'trip % is full', NEW."trip_id" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "trip_participants_capacity"
  BEFORE INSERT OR UPDATE OF "status" ON "trip_participants"
  FOR EACH ROW EXECUTE FUNCTION "enforce_trip_capacity"();

-- The maximum can't drop below the people already on the trip.
CREATE FUNCTION "enforce_trip_capacity_floor"() RETURNS trigger AS $$
BEGIN
  IF NEW."max_participants" < (
    SELECT count(*) FROM "trip_participants" WHERE "trip_id" = NEW."id" AND "status" = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'trip % has more participants than %', NEW."id", NEW."max_participants"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "trips_capacity_floor"
  BEFORE UPDATE OF "max_participants" ON "trips"
  FOR EACH ROW EXECUTE FUNCTION "enforce_trip_capacity_floor"();
