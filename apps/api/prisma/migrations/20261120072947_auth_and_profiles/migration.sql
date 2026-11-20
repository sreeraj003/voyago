/*
  Warnings:

  - You are about to drop the column `show_age` on the `user_preferences` table. All the data in the column will be lost.
  - You are about to drop the column `birth_date` on the `users` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "TravelStyle" AS ENUM ('BUDGET', 'COMFORT', 'LUXURY', 'ADVENTURE', 'RELAXED', 'CULTURAL', 'NATURE', 'SOCIAL');

-- CreateEnum
CREATE TYPE "RidingExperience" AS ENUM ('BEGINNER', 'INTERMEDIATE', 'EXPERIENCED', 'EXPERT');

-- CreateEnum
CREATE TYPE "VehicleVerificationStatus" AS ENUM ('UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "AuthProvider" AS ENUM ('GOOGLE', 'APPLE');

-- CreateEnum
CREATE TYPE "TokenPurpose" AS ENUM ('EMAIL_VERIFICATION', 'PASSWORD_RESET');

-- AlterTable
ALTER TABLE "motorcycles" ADD COLUMN     "verification_status" "VehicleVerificationStatus" NOT NULL DEFAULT 'UNVERIFIED';

-- AlterTable
ALTER TABLE "user_preferences" DROP COLUMN "show_age",
ADD COLUMN     "group_size_max" SMALLINT,
ADD COLUMN     "group_size_min" SMALLINT,
ADD COLUMN     "preferred_activities" "ActivityType"[] DEFAULT ARRAY[]::"ActivityType"[],
ADD COLUMN     "preferred_destinations" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "riding_experience" "RidingExperience",
ADD COLUMN     "travel_styles" "TravelStyle"[] DEFAULT ARRAY[]::"TravelStyle"[];

-- AlterTable
ALTER TABLE "users" DROP COLUMN "birth_date",
ADD COLUMN     "country" CHAR(2) NOT NULL DEFAULT 'IN',
ADD COLUMN     "languages" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "auth_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "refresh_token_hash" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "revoked_reason" VARCHAR(40),
    "replaced_by_id" UUID,
    "user_agent" VARCHAR(200),
    "last_used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_identities" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "provider" "AuthProvider" NOT NULL,
    "provider_user_id" VARCHAR(255) NOT NULL,
    "email" CITEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "otp_challenges" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "phone" VARCHAR(16) NOT NULL,
    "code_hash" CHAR(64) NOT NULL,
    "attempts" SMALLINT NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "otp_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "purpose" "TokenPurpose" NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verification_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "auth_sessions_refresh_token_hash_key" ON "auth_sessions"("refresh_token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "auth_sessions_replaced_by_id_key" ON "auth_sessions"("replaced_by_id");

-- CreateIndex
CREATE INDEX "auth_sessions_user_id_revoked_at_idx" ON "auth_sessions"("user_id", "revoked_at");

-- CreateIndex
CREATE INDEX "auth_sessions_family_id_idx" ON "auth_sessions"("family_id");

-- CreateIndex
CREATE INDEX "auth_sessions_expires_at_idx" ON "auth_sessions"("expires_at");

-- CreateIndex
CREATE INDEX "auth_identities_user_id_idx" ON "auth_identities"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "auth_identities_provider_provider_user_id_key" ON "auth_identities"("provider", "provider_user_id");

-- CreateIndex
CREATE INDEX "otp_challenges_phone_created_at_idx" ON "otp_challenges"("phone", "created_at" DESC);

-- CreateIndex
CREATE INDEX "otp_challenges_expires_at_idx" ON "otp_challenges"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "verification_tokens_token_hash_key" ON "verification_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "verification_tokens_user_id_purpose_idx" ON "verification_tokens"("user_id", "purpose");

-- AddForeignKey
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_replaced_by_id_fkey" FOREIGN KEY ("replaced_by_id") REFERENCES "auth_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_identities" ADD CONSTRAINT "auth_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verification_tokens" ADD CONSTRAINT "verification_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- Hand-written constraints
-- ─────────────────────────────────────────────────────────────────────────────

-- Birth date and the related "show age" setting are removed: the product has no clear need
-- to collect date of birth (spec 04), so it is not stored.

ALTER TABLE "users"
  ADD CONSTRAINT "users_country_format" CHECK ("country" ~ '^[A-Z]{2}$'),
  ADD CONSTRAINT "users_languages_limit" CHECK (cardinality("languages") <= 10);

ALTER TABLE "user_preferences"
  ADD CONSTRAINT "user_preferences_group_size_range" CHECK (
    ("group_size_min" IS NULL OR "group_size_min" BETWEEN 1 AND 500) AND
    ("group_size_max" IS NULL OR "group_size_max" BETWEEN 1 AND 500) AND
    ("group_size_min" IS NULL OR "group_size_max" IS NULL OR "group_size_min" <= "group_size_max")),
  ADD CONSTRAINT "user_preferences_list_limits" CHECK (
    cardinality("interests") <= 30 AND cardinality("preferred_destinations") <= 30);

ALTER TABLE "auth_sessions"
  ADD CONSTRAINT "auth_sessions_expiry_after_creation" CHECK ("expires_at" > "created_at"),
  ADD CONSTRAINT "auth_sessions_hash_format" CHECK ("refresh_token_hash" ~ '^[0-9a-f]{64}$');

ALTER TABLE "otp_challenges"
  ADD CONSTRAINT "otp_challenges_phone_e164" CHECK ("phone" ~ '^\+[1-9][0-9]{6,14}$'),
  ADD CONSTRAINT "otp_challenges_attempts_range" CHECK ("attempts" BETWEEN 0 AND 10),
  ADD CONSTRAINT "otp_challenges_hash_format" CHECK ("code_hash" ~ '^[0-9a-f]{64}$');

ALTER TABLE "verification_tokens"
  ADD CONSTRAINT "verification_tokens_hash_format" CHECK ("token_hash" ~ '^[0-9a-f]{64}$');
