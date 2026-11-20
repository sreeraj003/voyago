-- Milestone 09: realtime chat and push notifications.
-- Prisma's generated part first, then constraints and indexes it cannot express.

-- CreateEnum
CREATE TYPE "PushPlatform" AS ENUM ('IOS', 'ANDROID');

-- AlterEnum
ALTER TYPE "MessageType" ADD VALUE 'ANNOUNCEMENT';

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "client_id" UUID;

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "push_pending_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "push_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "token" VARCHAR(255) NOT NULL,
    "platform" "PushPlatform" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "push_tokens_token_key" ON "push_tokens"("token");

-- CreateIndex
CREATE INDEX "push_tokens_user_id_idx" ON "push_tokens"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "messages_conversation_id_sender_id_client_id_key" ON "messages"("conversation_id", "sender_id", "client_id");

-- AddForeignKey
ALTER TABLE "push_tokens" ADD CONSTRAINT "push_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;



-- ── Hand-written ────────────────────────────────────────────────────────────
-- A value added to an enum cannot be used in the same transaction, so checks compare as text.

-- Messages: text and announcements need words, photos need an image from our chat folder.
ALTER TABLE "messages" DROP CONSTRAINT "messages_content_present";
ALTER TABLE "messages" ADD CONSTRAINT "messages_content_present" CHECK (
  "deleted_at" IS NOT NULL OR
  ("type"::text IN ('TEXT', 'ANNOUNCEMENT') AND coalesce(btrim("body"), '') <> '' AND "sender_id" IS NOT NULL) OR
  ("type"::text = 'IMAGE' AND "attachment_key" IS NOT NULL) OR
  ("type"::text = 'SYSTEM' AND "body" IS NOT NULL AND "sender_id" IS NULL));
ALTER TABLE "messages" ADD CONSTRAINT "messages_attachment_key_format"
  CHECK ("attachment_key" IS NULL OR "attachment_key" ~ '^[a-z0-9_-]{1,40}/chat-photos/[0-9a-f-]{36}/[0-9a-f-]{36}$');
ALTER TABLE "messages" ADD CONSTRAINT "messages_body_length" CHECK (char_length("body") <= 2000);

-- Push tokens are Expo push tokens only.
ALTER TABLE "push_tokens" ADD CONSTRAINT "push_tokens_token_format"
  CHECK ("token" ~ '^Expo(nent)?PushToken\[[A-Za-z0-9_-]{10,200}\]$');

-- The push sender reads pending notifications oldest first.
CREATE INDEX "notifications_push_pending_idx" ON "notifications" ("push_pending_at")
  WHERE "push_pending_at" IS NOT NULL;
-- The chat list reads conversations by latest message; ones without messages are not listed.
CREATE INDEX "conversations_last_message_at_idx" ON "conversations" ("last_message_at" DESC, "id" DESC)
  WHERE "last_message_at" IS NOT NULL;
