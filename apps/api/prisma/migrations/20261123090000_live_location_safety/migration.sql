-- Milestone 11: live location and safety.
-- Coordinates are not stored for location sharing: they live in Redis with a TTL. Only an
-- active SOS alert keeps the last known point, and it is cleared when the alert is resolved.
-- CreateEnum
CREATE TYPE "CheckInKind" AS ENUM ('AT_START', 'ALL_GOOD', 'ARRIVED_SAFELY');

-- CreateEnum
CREATE TYPE "SosStatus" AS ENUM ('ACTIVE', 'RESOLVED', 'CANCELLED');

-- AlterTable
ALTER TABLE "location_sessions" ADD COLUMN     "end_reason" VARCHAR(20);

-- CreateTable
CREATE TABLE "emergency_contacts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "phone" VARCHAR(16) NOT NULL,
    "relationship" VARCHAR(40),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "emergency_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trip_check_ins" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "trip_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" "CheckInKind" NOT NULL,
    "note" VARCHAR(200),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trip_check_ins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sos_alerts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "trip_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" "SosStatus" NOT NULL DEFAULT 'ACTIVE',
    "message" VARCHAR(300),
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "location_recorded_at" TIMESTAMPTZ(3),
    "members_notified" INTEGER NOT NULL DEFAULT 0,
    "contacts_texted" INTEGER NOT NULL DEFAULT 0,
    "resolved_at" TIMESTAMPTZ(3),
    "resolved_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sos_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "emergency_contacts_user_id_phone_key" ON "emergency_contacts"("user_id", "phone");

-- CreateIndex
CREATE INDEX "trip_check_ins_trip_id_created_at_idx" ON "trip_check_ins"("trip_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "sos_alerts_trip_id_created_at_idx" ON "sos_alerts"("trip_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "sos_alerts_user_id_idx" ON "sos_alerts"("user_id");

-- AddForeignKey
ALTER TABLE "emergency_contacts" ADD CONSTRAINT "emergency_contacts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_check_ins" ADD CONSTRAINT "trip_check_ins_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "trips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_check_ins" ADD CONSTRAINT "trip_check_ins_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sos_alerts" ADD CONSTRAINT "sos_alerts_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "trips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sos_alerts" ADD CONSTRAINT "sos_alerts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sos_alerts" ADD CONSTRAINT "sos_alerts_resolved_by_id_fkey" FOREIGN KEY ("resolved_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ── Checks ──────────────────────────────────────────────────────────────────
ALTER TABLE "location_sessions" ADD CONSTRAINT "location_sessions_end_reason"
  CHECK ("end_reason" IS NULL OR "end_reason" IN ('stopped', 'trip_ended', 'left_trip', 'replaced', 'expired', 'suspended'));

ALTER TABLE "emergency_contacts" ADD CONSTRAINT "emergency_contacts_phone_format"
  CHECK ("phone" ~ '^\+[1-9][0-9]{6,14}$');
ALTER TABLE "emergency_contacts" ADD CONSTRAINT "emergency_contacts_name_present"
  CHECK (btrim("name") <> '');

-- A location is a full point or nothing, in range, and only while the alert is active.
ALTER TABLE "sos_alerts" ADD CONSTRAINT "sos_alerts_location_complete"
  CHECK (("latitude" IS NULL) = ("longitude" IS NULL) AND ("latitude" IS NULL) = ("location_recorded_at" IS NULL));
ALTER TABLE "sos_alerts" ADD CONSTRAINT "sos_alerts_location_range"
  CHECK ("latitude" IS NULL OR ("latitude" BETWEEN -90 AND 90 AND "longitude" BETWEEN -180 AND 180));
ALTER TABLE "sos_alerts" ADD CONSTRAINT "sos_alerts_location_only_while_active"
  CHECK ("status" = 'ACTIVE' OR "latitude" IS NULL);
ALTER TABLE "sos_alerts" ADD CONSTRAINT "sos_alerts_resolution"
  CHECK (("status" = 'ACTIVE') = ("resolved_at" IS NULL));

-- One active SOS per member per trip.
CREATE UNIQUE INDEX "sos_alerts_one_active" ON "sos_alerts" ("trip_id", "user_id") WHERE "status" = 'ACTIVE';
