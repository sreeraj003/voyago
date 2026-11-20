# 09 --- Realtime Chat and Notifications

Implement realtime communication using Socket.IO.

## Conversation types

-   Direct message.
-   Trip group conversation.
-   Community group conversation.

## Messaging

-   text messages
-   image attachments using secure object storage
-   timestamps
-   read receipts
-   typing indicators
-   group membership management
-   announcements
-   pagination of message history

Persist messages in PostgreSQL. Use Redis for transient presence and
Socket.IO scaling where needed.

## Authorization

-   Authenticate every socket connection.
-   Authorise every conversation join.
-   Only members can read/send in a conversation.
-   Enforce block rules.
-   Validate message size and attachment type.
-   Rate-limit message sending.
-   Do not expose private conversations to admins except through a
    documented, access-controlled moderation process.

## Suggested socket events

Client: - conversation:join - conversation:leave - message:send -
message:read - typing:start - typing:stop

Server: - message:new - message:read - typing:update - user:online -
user:offline

## Notifications

Implement in-app notifications first. Add push notifications through
FCM/APNs after credentials are configured.

Notification types: - join request - approval/rejection - new message -
trip update - trip cancellation - community invitation - booking updates
in a later milestone

## Tests

Test socket authentication, membership enforcement, block enforcement,
persistence, pagination and duplicate event handling.

## Completion gate

Authorised users can communicate in real time and receive notifications.
Update docs.
