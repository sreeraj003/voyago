-- Milestone 08: communities, social graph and feed; plus trip co-organisers and invitations.
-- Prisma's generated part first, then constraints and indexes it cannot express.

-- CreateEnum
CREATE TYPE "CommunityCategory" AS ENUM ('RIDING_CLUB', 'TOURING', 'TREKKING', 'BACKPACKING', 'ROAD_TRIPS', 'PHOTOGRAPHY', 'OTHER');

-- CreateEnum
CREATE TYPE "TripInvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'REVOKED');

-- CreateEnum
CREATE TYPE "PostType" AS ENUM ('TRIP_RECAP', 'PHOTO', 'ANNOUNCEMENT');

-- CreateEnum
CREATE TYPE "PostVisibility" AS ENUM ('PUBLIC', 'FOLLOWERS', 'COMMUNITY');

-- AlterEnum


ALTER TYPE "MembershipStatus" ADD VALUE 'LEFT';
ALTER TYPE "MembershipStatus" ADD VALUE 'REMOVED';

-- AlterEnum


ALTER TYPE "NotificationType" ADD VALUE 'TRIP_INVITE';
ALTER TYPE "NotificationType" ADD VALUE 'COMMUNITY_UPDATE';

-- AlterEnum
ALTER TYPE "ReportTargetType" ADD VALUE 'POST';

-- AlterTable
ALTER TABLE "communities" ADD COLUMN     "category" "CommunityCategory" NOT NULL DEFAULT 'OTHER';

-- AlterTable
ALTER TABLE "community_members" ADD COLUMN     "message" VARCHAR(500);

-- CreateTable
CREATE TABLE "trip_invitations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "trip_id" UUID NOT NULL,
    "invitee_id" UUID NOT NULL,
    "invited_by_id" UUID,
    "status" "TripInvitationStatus" NOT NULL DEFAULT 'PENDING',
    "responded_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "trip_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "posts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "author_id" UUID NOT NULL,
    "type" "PostType" NOT NULL,
    "visibility" "PostVisibility" NOT NULL DEFAULT 'PUBLIC',
    "community_id" UUID,
    "trip_id" UUID,
    "body" VARCHAR(2000),
    "image_keys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "place_name" VARCHAR(160),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "posts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "trip_invitations_trip_id_status_idx" ON "trip_invitations"("trip_id", "status");

-- CreateIndex
CREATE INDEX "trip_invitations_invitee_id_status_idx" ON "trip_invitations"("invitee_id", "status");

-- CreateIndex
CREATE INDEX "posts_author_id_created_at_idx" ON "posts"("author_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "posts_community_id_created_at_idx" ON "posts"("community_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "posts_created_at_idx" ON "posts"("created_at" DESC);

-- CreateIndex
CREATE INDEX "community_members_community_id_status_idx" ON "community_members"("community_id", "status");

-- AddForeignKey
ALTER TABLE "trip_invitations" ADD CONSTRAINT "trip_invitations_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "trips"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_invitations" ADD CONSTRAINT "trip_invitations_invitee_id_fkey" FOREIGN KEY ("invitee_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_invitations" ADD CONSTRAINT "trip_invitations_invited_by_id_fkey" FOREIGN KEY ("invited_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "posts" ADD CONSTRAINT "posts_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "posts" ADD CONSTRAINT "posts_community_id_fkey" FOREIGN KEY ("community_id") REFERENCES "communities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "posts" ADD CONSTRAINT "posts_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "trips"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ── Hand-written ────────────────────────────────────────────────────────────

-- One pending invitation per person and trip; no self-invitations.
CREATE UNIQUE INDEX "trip_invitations_one_pending" ON "trip_invitations" ("trip_id", "invitee_id")
  WHERE "status" = 'PENDING';
ALTER TABLE "trip_invitations" ADD CONSTRAINT "trip_invitations_responded_when_closed"
  CHECK (("status" = 'PENDING') = ("responded_at" IS NULL));

-- Communities: private ones always need approval; one owner each.
ALTER TABLE "communities" ADD CONSTRAINT "communities_private_needs_approval"
  CHECK ("visibility" = 'PUBLIC' OR "join_policy" = 'APPROVAL');
ALTER TABLE "communities" ADD CONSTRAINT "communities_slug_format"
  CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length("slug") BETWEEN 3 AND 60);
ALTER TABLE "communities" ADD CONSTRAINT "communities_name_not_blank" CHECK (btrim("name") <> '');
ALTER TABLE "communities" ADD CONSTRAINT "communities_cover_image_key_format"
  CHECK ("cover_image_key" IS NULL OR "cover_image_key" ~ '^[a-z0-9_-]{1,40}/community-covers/[0-9a-f-]{36}/[0-9a-f-]{36}$');
CREATE UNIQUE INDEX "community_members_one_owner" ON "community_members" ("community_id")
  WHERE "role" = 'OWNER';

-- Posts: what each type needs, and image ids from our own upload folder.
ALTER TABLE "posts" ADD CONSTRAINT "posts_content_present"
  CHECK (coalesce(btrim("body"), '') <> '' OR coalesce(cardinality("image_keys"), 0) > 0);
ALTER TABLE "posts" ADD CONSTRAINT "posts_image_count" CHECK (coalesce(cardinality("image_keys"), 0) <= 6);
ALTER TABLE "posts" ADD CONSTRAINT "posts_announcement_in_community"
  CHECK ("type" <> 'ANNOUNCEMENT' OR "community_id" IS NOT NULL);
ALTER TABLE "posts" ADD CONSTRAINT "posts_community_visibility_needs_community"
  CHECK ("visibility" <> 'COMMUNITY' OR "community_id" IS NOT NULL);
ALTER TABLE "posts" ADD CONSTRAINT "posts_recap_has_trip"
  CHECK ("type" <> 'TRIP_RECAP' OR "trip_id" IS NOT NULL);
ALTER TABLE "posts" ADD CONSTRAINT "posts_image_keys_format"
  CHECK (array_to_string(coalesce("image_keys", '{}'), ',') ~ '^([a-z0-9_-]{1,40}/post-photos/[0-9a-f-]{36}/[0-9a-f-]{36}(,|$))*$');
-- Feed reads posts in a community or by followed authors, newest first, skipping deleted rows.
CREATE INDEX "posts_live_created_idx" ON "posts" ("created_at" DESC, "id" DESC) WHERE "deleted_at" IS NULL;
-- Trip announcements in the feed come from published trips.
CREATE INDEX "trips_published_at_idx" ON "trips" ("published_at" DESC) WHERE "published_at" IS NOT NULL AND "deleted_at" IS NULL;
