# Voyago API conventions

Every endpoint follows these rules. They are enforced by shared code in `apps/api/src/common` and
covered by `apps/api/test/api-foundation.e2e-spec.ts`.

- **Base URL:** `/api/v1` (for example `http://localhost:3000/api/v1`).
- **Interactive docs:** `/api/docs` (Swagger UI); machine-readable OpenAPI at `/api/docs-json`.
- **Format:** JSON request and response bodies, UTF-8. Request bodies are limited to 100 KB;
  files go directly to object storage, not through the API.
- **Time:** ISO 8601 strings in UTC (`2026-11-20T07:00:00.000Z`).
- **Money:** integers in paise with a `currency` code (`"INR"`). Never floats.
- **Ids:** UUID strings.

## Endpoints implemented so far

| Method | Path                   | Auth   | Description                                                              |
| ------ | ---------------------- | ------ | ------------------------------------------------------------------------ |
| GET    | `/api/v1/health/live`  | Public | Liveness. 200 while the process runs. Never checks dependencies.         |
| GET    | `/api/v1/health/ready` | Public | Readiness. 200 when PostgreSQL, PostGIS and Redis are up; 503 otherwise. |
| GET    | `/api/v1/health`       | Public | Alias of `/health/ready` (used by the mobile and admin apps).            |
| GET    | `/api/docs`            | Public | Swagger UI.                                                              |

### Authentication (`/api/v1/auth`)

| Method | Path                         | Auth   | Success | Description                                                            |
| ------ | ---------------------------- | ------ | ------- | ---------------------------------------------------------------------- |
| GET    | `/auth/methods`              | Public | 200     | Which sign-in methods this server has configured.                      |
| POST   | `/auth/register`             | Public | 202     | Email, password, username, display name. Same reply if email exists.   |
| POST   | `/auth/login`                | Public | 200     | Email + password → tokens. One generic 401 for every failure.          |
| POST   | `/auth/refresh`              | Public | 200     | Rotates the refresh token. Reusing an old one signs out that device.   |
| POST   | `/auth/logout`               | Bearer | 204     | Signs out this device.                                                 |
| POST   | `/auth/logout-all`           | Bearer | 204     | Signs out every device.                                                |
| POST   | `/auth/otp/request`          | Public | 202     | Texts a 6-digit code. 503 when no SMS provider is configured.          |
| POST   | `/auth/otp/verify`           | Public | 200     | `AUTHENTICATED` with tokens, or `SIGNUP_REQUIRED` with a signup token. |
| POST   | `/auth/social/:provider`     | Public | 200     | `google` or `apple` ID token. Same result shape as OTP verify.         |
| POST   | `/auth/signup/complete`      | Public | 201     | Signup token + username + display name → tokens.                       |
| POST   | `/auth/email/verify/request` | Bearer | 202     | Sends a new verification link.                                         |
| POST   | `/auth/email/verify`         | Public | 204     | Confirms the email with the link token.                                |
| POST   | `/auth/password/forgot`      | Public | 202     | Emails a reset link (1 hour). Same reply if the account is unknown.    |
| POST   | `/auth/password/reset`       | Public | 204     | New password with the link token. Signs out every device.              |
| POST   | `/auth/password/change`      | Bearer | 204     | Current + new password. Signs out other devices.                       |

### Profiles

| Method | Path                  | Auth   | Description                                                                  |
| ------ | --------------------- | ------ | ---------------------------------------------------------------------------- |
| GET    | `/me`                 | Bearer | My profile, including my email, phone and verification status.               |
| PATCH  | `/me`                 | Bearer | Name, username, bio, city, country, languages. Other fields are ignored.     |
| GET    | `/me/preferences`     | Bearer | Travel preferences, profile visibility, messaging and notification settings. |
| PATCH  | `/me/preferences`     | Bearer | Partial update. Ranges are checked against stored values too.                |
| GET    | `/me/motorcycles`     | Bearer | My motorcycles, primary first.                                               |
| POST   | `/me/motorcycles`     | Bearer | Add (max 10). No registration numbers or documents are accepted.             |
| PATCH  | `/me/motorcycles/:id` | Bearer | Update. Another member's id returns 404.                                     |
| DELETE | `/me/motorcycles/:id` | Bearer | Remove. Another member's id returns 404.                                     |
| GET    | `/users/:username`    | Bearer | Public profile. Never contains email or phone. Blocked or inactive → 404.    |

Public profiles: `PUBLIC` shows the full public profile to signed-in members; `FOLLOWERS` shows it
to followers and the basics (name, username, verification badges) to others; `PRIVATE` shows only
the basics. Schemas: `PrivateProfileSchema`, `PublicProfileSchema` in `@voyago/shared`.

Health endpoints are not rate limited and not wrapped in `{ data }`, because load balancers and
orchestrators read them directly.

```json
// GET /api/v1/health/ready → 503
{
  "status": "degraded",
  "version": "0.1.0",
  "uptimeSeconds": 42,
  "timestamp": "2026-11-20T07:00:00.000Z",
  "checks": { "database": "up", "postgis": "up", "redis": "down" }
}
```

### Trips

| Method | Path                  | Auth   | Success | Description                                                                   |
| ------ | --------------------- | ------ | ------- | ----------------------------------------------------------------------------- |
| POST   | `/trips`              | Bearer | 201     | Create a free community trip as a `DRAFT`. The organiser joins it.            |
| GET    | `/trips/:id`          | Bearer | 200     | Trip details, with `viewer.actions` (what the caller may do now).             |
| PATCH  | `/trips/:id`          | Bearer | 200     | Edit (organiser). `stops` replaces the list. See locking rules below.         |
| DELETE | `/trips/:id`          | Bearer | 204     | Delete a draft. Published trips are cancelled instead.                        |
| POST   | `/trips/:id/publish`  | Bearer | 200     | `DRAFT` → `PUBLISHED` (or `FULL`). Departure must be in the future.           |
| POST   | `/trips/:id/start`    | Bearer | 200     | → `IN_PROGRESS`, from 2 hours before departure.                               |
| POST   | `/trips/:id/complete` | Bearer | 200     | `IN_PROGRESS` → `COMPLETED`.                                                  |
| POST   | `/trips/:id/cancel`   | Bearer | 200     | `{ reason }`. Organiser, or a moderator/admin (audit logged).                 |
| GET    | `/me/trips`           | Bearer | 200     | Trips I organise or joined. `role=organising\|joined\|all`, `status`, cursor. |

**Lifecycle** (`TRIP_TRANSITIONS` in `@voyago/shared`, enforced by the API; the client never sets
`status`): `DRAFT → PUBLISHED ⇄ FULL → IN_PROGRESS → COMPLETED`, with `CANCELLED` (from any
non-terminal state) and `EXPIRED` (published trips not started 24 hours after departure, set by a
job every 15 minutes). `FULL` follows capacity automatically. Any other change returns 409.

**Rules:** departure in the future (and within 2 years) when set or published; return after
departure and at most 60 days later; 2 to 500 people (organiser included), minimum ≤ maximum,
maximum not below the people already on the trip; Ride mode is always `MOTORCYCLE_RIDE` and
engine size applies to rides only; up to 25 stops with valid coordinates and arrival times after
departure. Rule failures return 400 with `details`.

**Locking:** mode and activity are fixed once published. Once a trip has started (status or
departure time), only `description` and `coverImageId` can change; finished trips cannot change at
all.

**Access:** drafts are visible only to their organiser; `PRIVATE` trips only to participants;
blocked users in either direction get 404; moderators and admins see everything. The exact meeting
point goes to participants only; others get `origin.approximate: true` with the point rounded to
about 1 km. `estimatedDistanceKm` / `estimatedDurationMinutes` are always the organiser's own
(`estimatesSource: "ORGANISER"`). `route` is the road distance and duration from the Google Routes
API (`source: "GOOGLE"`, `travelMode` `TWO_WHEELER` for rides, `DRIVE` for travel), computed
through origin, stops and destination when the trip is created, its route changes, or it is
published; it is `null` when Google is not configured or returned no route, and Voyago never
invents one. The budget is a per-person cost-sharing estimate in paise, never a price.

**Cover image:** `coverImageId` on create/update is an id returned by
`POST /uploads/cover-signature` after the app uploaded the photo to Cloudinary (`null` removes the
cover). The API accepts only ids in the caller's own upload folder and checks with Cloudinary that
the image exists and is under 8 MB; anything else is 400, and 503 when uploads are not configured.
Trips return `coverImageUrl`, a resized Cloudinary delivery URL.

**Membership changes:** starting a trip closes its pending requests; completing it marks active
participants `COMPLETED`; cancelling closes pending requests and notifies everyone involved.

**Free vs commercial:** these endpoints only create `COMMUNITY_FREE` trips; `tripType`, `status`
and `organiserId` in a request are ignored. `COMMERCIAL_PAID` departures cannot be edited or
cancelled here (409); they are managed from their package (milestone 12).

### Joining and participants

Joining a community trip is free. These routes never touch commercial bookings (409 for
commercial departures).

| Method | Path                                     | Auth   | Success | Description                                                                                    |
| ------ | ---------------------------------------- | ------ | ------- | ---------------------------------------------------------------------------------------------- |
| POST   | `/trips/:id/join-requests`               | Bearer | 201     | `{ message? }`. Ask to join; open trips (`approvalRequired: false`) join at once (`APPROVED`). |
| GET    | `/trips/:id/join-requests`               | Bearer | 200     | Organiser and staff. `status` (default `PENDING`), cursor.                                     |
| GET    | `/me/join-requests`                      | Bearer | 200     | My requests, newest first. Optional `status`.                                                  |
| POST   | `/join-requests/:id/approve`             | Bearer | 200     | Organiser or staff. 409 if the trip filled up or the request closed.                           |
| POST   | `/join-requests/:id/reject`              | Bearer | 200     | `{ reason? }`, shown to the member.                                                            |
| POST   | `/join-requests/:id/withdraw`            | Bearer | 200     | The requester only, while `PENDING`.                                                           |
| GET    | `/trips/:id/participants`                | Bearer | 200     | Participants, the organiser and staff only. Public profile fields.                             |
| POST   | `/trips/:id/participants/:userId/remove` | Bearer | 204     | `{ reason? }`. Organiser, co-organiser (participants only) or staff; always audit logged.      |
| POST   | `/trips/:id/participants/:userId/role`   | Bearer | 200     | `{ role: CO_ORGANISER \| PARTICIPANT }`. Organiser only. Returns the people list.              |
| POST   | `/trips/:id/leave`                       | Bearer | 204     | Leave a trip you joined (not the organiser).                                                   |
| POST   | `/trips/:id/invitations`                 | Bearer | 201     | `{ username }`. Organisers. Unknown or blocked usernames → 404.                                |
| GET    | `/trips/:id/invitations`                 | Bearer | 200     | Organisers. `status` (default `PENDING`), cursor.                                              |
| GET    | `/me/trip-invitations`                   | Bearer | 200     | Invitations I received. `status` (default `PENDING`), cursor.                                  |
| POST   | `/trip-invitations/:id/accept`           | Bearer | 200     | The invitee joins at once (capacity checked with the trip locked; 409 when full).              |
| POST   | `/trip-invitations/:id/decline`          | Bearer | 200     | The invitee says no.                                                                           |
| POST   | `/trip-invitations/:id/revoke`           | Bearer | 200     | Organisers withdraw an open invitation.                                                        |

**Statuses:** join requests are `PENDING`, `APPROVED`, `REJECTED`, `WITHDRAWN` or `CANCELLED`
(closed by the system when the trip is cancelled, started or expires). Participants are
`ACTIVE`, `COMPLETED` (the trip finished with them on it), `LEFT` or `REMOVED`.

**Rules:** not your own trip; one pending request per member and trip (409 otherwise; asking
again after a withdrawal, a decline or leaving is fine); private trips, drafts and blocked
organisers return 404; private trips are joined only by invitation (409 for a request); only
`PUBLISHED` trips that haven't departed take people (`FULL` → 409
"This trip is full"); removed members cannot ask again (403); nobody decides their own request;
the organiser, co-organisers and staff decide requests and remove people, but co-organisers
can't remove other co-organisers and the organiser can't be removed.

**Co-organisers** are participants the organiser promotes. They review requests, invite people
and remove participants (audit logged); editing, publishing, starting, completing and cancelling
stay with the organiser.

**Invitations** let people see and join private trips (and skip approval on other trips). One
open invitation per person and trip. Cancelling, starting or expiring a trip, or a block between
the two people, withdraws open invitations (`REVOKED`).

**Capacity** is checked with the trip row locked (`SELECT … FOR UPDATE`) while approving, and a
database trigger rejects any participant beyond `max_participants` (and any lowering of the
maximum below the people already on the trip), so simultaneous approvals cannot overfill a trip.
`PUBLISHED ⇄ FULL` follows every join, leave and removal.

**Trip view additions:** `viewer.participantStatus`, `viewer.joinRequest` (latest, `{ id,
status }`), `viewer.pendingRequestCount` (organisers and staff), `viewer.isCoOrganiser`,
`viewer.invitationId` (a pending invitation), `community` (`{ id, slug, name }` or null), and the
actions `join`, `leave` and `manage_people`.

### Notifications

| Method | Path                             | Auth   | Success | Description                              |
| ------ | -------------------------------- | ------ | ------- | ---------------------------------------- |
| GET    | `/me/notifications`              | Bearer | 200     | Newest first; `unreadOnly=true`, cursor. |
| GET    | `/me/notifications/unread-count` | Bearer | 200     | `{ count }`, chat messages left out.     |
| POST   | `/me/notifications/:id/read`     | Bearer | 204     | Mark one read (404 for someone else's).  |
| POST   | `/me/notifications/read-all`     | Bearer | 200     | `{ updated }`.                           |
| POST   | `/me/push-tokens`                | Bearer | 204     | Register an Expo push token + platform.  |
| POST   | `/me/push-tokens/remove`         | Bearer | 204     | Stop pushes to a device (on sign-out).   |

In-app notifications are created in the same transaction as the change they describe: new join
request (or someone joined an open trip), request approved or declined, removed from a trip,
trip updated (departure, return, places, stops or title; description edits are not announced),
trip cancelled (participants, pending requesters and invitees), a reminder within 24 hours of
departure (sent once per trip), trip invitations, new followers, and community updates (requests
for moderators, approvals, removals, announcements). `data` carries ids, a community slug or a
username or a chat id only.

Chat messages create one unread `NEW_MESSAGE` notification per member and chat (later messages
update it) for members who don't have the chat open: every message in direct and trip chats,
announcements only in community chats; muted chats and blocked people are skipped.

**Push:** every notification is also pushed to the member's registered devices when
`PUSH_PROVIDER=expo` (Expo's push service, which delivers through FCM and APNs) and the member
hasn't turned pushes off (`pushEnabled`). Pushes leave from an outbox (`push_pending_at`) after
the transaction commits, at most once, and are dropped if they can't go out within 15 minutes.
Devices Expo reports as unregistered are forgotten. With `PUSH_PROVIDER=none` everything stays
in-app.

### Chat

| Method | Path                             | Auth   | Success | Description                                            |
| ------ | -------------------------------- | ------ | ------- | ------------------------------------------------------ |
| GET    | `/me/conversations`              | Bearer | 200     | My chats with messages, latest first (cursor).         |
| GET    | `/me/conversations/unread-count` | Bearer | 200     | Unread messages in my 50 latest chats, muted excluded. |
| POST   | `/conversations/direct`          | Bearer | 200     | `{ username }`: existing chat, or start one (403).     |
| POST   | `/trips/:id/chat`                | Bearer | 200     | The trip's group chat (people on the trip).            |
| POST   | `/communities/:slug/chat`        | Bearer | 200     | The community chat (active members).                   |
| GET    | `/conversations/:id`             | Bearer | 200     | Chat details, unread count, read positions.            |
| GET    | `/conversations/:id/messages`    | Bearer | 200     | History, newest first (cursor, `limit` up to 100).     |
| POST   | `/conversations/:id/messages`    | Bearer | 201     | Send (`clientId`, `body` and/or `imageId`).            |
| POST   | `/conversations/:id/read`        | Bearer | 200     | `{ messageId }`: read up to there (never moves back).  |
| POST   | `/conversations/:id/mute`        | Bearer | 200     | `{ muted }`.                                           |
| POST   | `/messages/:id/delete`           | Bearer | 204     | Delete my own message for everyone.                    |

- **Who belongs:** direct chats, their two members; trip chats, everyone on the trip (active, or
  finished with it); community chats, active members. Membership follows the trip or community,
  so leaving or being removed ends access at once (and live sockets are taken out of the room).
  Anyone else gets 404, so chats can't be probed. Staff have no route to read chats: moderation
  works from reports (milestone 10).
- **Direct messages** follow the recipient's `allowMessagesFrom`: `EVERYONE`, `FOLLOWERS` (you
  follow them), `TRIP_PARTICIPANTS` (default: you share a trip) or `NOBODY`. Once they have
  written to you, you may reply unless they chose `NOBODY`. A block in either direction closes the
  chat (`canSend: false`, sends 403). Profiles show `canMessage`.
- **Messages:** text up to 2,000 characters, or a photo (`imageId` from an upload signature of
  kind `chat-photo`, checked to be the sender's own upload) with an optional caption.
  Organisers, co-organisers and community moderators can send `announcement: true` (text only;
  notifies everyone, even muted). `clientId` (a UUID per message) makes sending idempotent:
  resending returns the stored message instead of a copy. 30 messages per member per minute
  (`CHAT_RATE_LIMIT_PER_MINUTE`), 429 beyond.
- **Photos are private:** uploaded as Cloudinary "authenticated" assets; `imageUrl` is a signed
  link the server gives only to members.
- **Blocks in groups:** messages from people you blocked (or who blocked you) are left out of
  history, live delivery, typing and read positions.

#### Realtime (Socket.IO)

Connect to the API origin with path `/api/v1/realtime` and `auth: { token: <access token> }`.
Without a valid token the connection fails with `unauthorized`. The socket is closed when the
token expires (reconnect with a fresh one), and the session is checked again on every join and
send, so signing out or suspension cuts it off. Every request is acknowledged with
`{ ok: true, data }` or `{ ok: false, error: { status, message } }`, using the same status codes
as REST. Redis carries events between API instances.

| Client sends         | Payload                                                        | Answer                    |
| -------------------- | -------------------------------------------------------------- | ------------------------- |
| `conversation:join`  | `{ conversationId }`                                           | `{ onlineUserIds }` (404) |
| `conversation:leave` | `{ conversationId }`                                           | -                         |
| `message:send`       | `{ conversationId, clientId, body?, imageId?, announcement? }` | the stored message        |
| `message:read`       | `{ conversationId, messageId }`                                | `{ userId, lastReadAt }`  |
| `typing:start`       | `{ conversationId }` (joined chats only, 1 per 1.5 s)          | -                         |
| `typing:stop`        | `{ conversationId }`                                           | -                         |

| Server sends      | Payload                                           | To                                                                    |
| ----------------- | ------------------------------------------------- | --------------------------------------------------------------------- |
| `message:new`     | a message                                         | the chat's room, plus every direct and trip chat member's own devices |
| `message:deleted` | `{ conversationId, messageId }`                   | the chat's room                                                       |
| `message:read`    | `{ conversationId, userId, lastReadAt }`          | the chat's room                                                       |
| `typing:update`   | `{ conversationId, userId, displayName, typing }` | the chat's room, except the typist                                    |
| `user:online`     | `{ conversationId, userId }`                      | the chat's room                                                       |
| `user:offline`    | `{ conversationId, userId }`                      | the chat's room                                                       |

Presence is "has the chat open right now": it comes from live sockets, so nothing is stored.

### Communities

Private communities show their name, description, category, city and owner to everyone, so
people can ask to join; their trips, posts and members are visible to members only (403).

| Method | Path                                         | Auth   | Success | Description                                                                                          |
| ------ | -------------------------------------------- | ------ | ------- | ---------------------------------------------------------------------------------------------------- |
| POST   | `/communities`                               | Bearer | 201     | Create; you become `OWNER`. Private communities must use `APPROVAL`. Slug taken → 409.               |
| GET    | `/communities`                               | Bearer | 200     | `q`, `mode` (also matches both-mode communities), `category`, `city`, `mine`, cursor.                |
| GET    | `/communities/:slug`                         | Bearer | 200     | With `viewer { role, status, canSeeContent, actions }`.                                              |
| PATCH  | `/communities/:slug`                         | Bearer | 200     | Admins and the owner. The slug is fixed.                                                             |
| DELETE | `/communities/:slug`                         | Bearer | 204     | Owner only (soft delete).                                                                            |
| POST   | `/communities/:slug/join`                    | Bearer | 200     | `{ message? }`. Open public: joined at once. Otherwise a request (`PENDING`).                        |
| POST   | `/communities/:slug/leave`                   | Bearer | 200     | Leave or cancel a request. The owner can't leave (409).                                              |
| GET    | `/communities/:slug/members`                 | Bearer | 200     | `status` `ACTIVE` (members) or `PENDING` / `BANNED` (moderators). Request notes for moderators only. |
| POST   | `/communities/:slug/members/:userId/approve` | Bearer | 204     | Moderators. Audit logged.                                                                            |
| POST   | `/communities/:slug/members/:userId/reject`  | Bearer | 204     | Moderators. Audit logged.                                                                            |
| POST   | `/communities/:slug/members/:userId/role`    | Bearer | 204     | `{ role: ADMIN \| MODERATOR \| MEMBER }`. Admins and the owner. Audit logged.                        |
| POST   | `/communities/:slug/members/:userId/remove`  | Bearer | 204     | `{ reason?, ban? }`. Moderators. Audit logged.                                                       |
| POST   | `/communities/:slug/members/:userId/unban`   | Bearer | 204     | Admins. Audit logged.                                                                                |
| GET    | `/communities/:slug/trips`                   | Bearer | 200     | `when` `upcoming` (soonest first) or `past`. Members-only trips for members only.                    |
| GET    | `/communities/:slug/posts`                   | Bearer | 200     | Posts and announcements; non-members of a public community see public ones only.                     |
| POST   | `/communities/:slug/announcements`           | Bearer | 201     | `{ body, membersOnly? }`. Moderators. Members are notified.                                          |

**Roles** rank `OWNER` > `ADMIN` > `MODERATOR` > `MEMBER`. Nobody can act on someone at or above
their own rank, give a role at or above their own, or change their own role, so nobody can raise
their own privileges. One owner per community (database index). Banned members can't ask again
until an admin lifts the ban. Someone who blocked the owner, or was blocked by them, can't join.

**Community trips:** trips take an optional `communityId` (you must be an active member) and the
visibility `COMMUNITY`, which shows the trip to that community's active members only (404 for
everyone else). Community trips never appear in public discovery.

### Social

| Method | Path                         | Auth   | Success | Description                                                                                                                   |
| ------ | ---------------------------- | ------ | ------- | ----------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/users/:username/follow`    | Bearer | 204     | Follow (no-op if already). The member is notified once.                                                                       |
| DELETE | `/users/:username/follow`    | Bearer | 204     | Unfollow.                                                                                                                     |
| GET    | `/users/:username/followers` | Bearer | 200     | `{ user, since, isFollowing }[]`, cursor. 403 unless their profile is fully visible.                                          |
| GET    | `/users/:username/following` | Bearer | 200     | Same rules as followers.                                                                                                      |
| POST   | `/users/:username/block`     | Bearer | 204     | Free and always available. Removes follows both ways and open invitations between you.                                        |
| DELETE | `/users/:username/block`     | Bearer | 204     | Unblock.                                                                                                                      |
| GET    | `/me/blocks`                 | Bearer | 200     | People I blocked.                                                                                                             |
| POST   | `/reports`                   | Bearer | 201     | `{ targetType: USER \| TRIP \| COMMUNITY \| POST, targetId, reason, details? }`. A repeat while open returns the same report. |

Public profiles gain `follow { followerCount, followingCount, isFollowing, followsYou, mutual }`.
`followsYou` (and so `mutual`) is shown only when their profile is visible to you. A block in
either direction makes profiles, trips, posts and feed items disappear both ways (404).

### Posts and feed

| Method | Path         | Auth   | Success | Description                                                                                             |
| ------ | ------------ | ------ | ------- | ------------------------------------------------------------------------------------------------------- |
| GET    | `/feed`      | Bearer | 200     | Newest first, cursor. Posts and newly published trips from people I follow, my own and my communities'. |
| POST   | `/posts`     | Bearer | 201     | `TRIP_RECAP` (a completed trip you were on) or `PHOTO` (1–6 uploaded photos, kind `post-photo`).        |
| DELETE | `/posts/:id` | Bearer | 204     | Author; community moderators and staff (audit logged).                                                  |

Post `visibility` is `PUBLIC`, `FOLLOWERS` or `COMMUNITY` (needs `communityId`). Posts in a
private community are always `COMMUNITY`. A post names its trip only if the trip is public.
Places are names, never coordinates; the app strips photo metadata before upload. The feed is
plain reverse-chronological with no ranking; items carry `kind` (`post` or `trip`) and `at`.

### Discovery

All four routes return only public community trips that are published (or full, when asked) and
have not departed, run by active members, excluding anyone the caller has blocked or been blocked
by. Results are trip cards (`TripCardSchema` in `@voyago/shared`).

| Method | Path                      | Auth   | Success | Description                                                              |
| ------ | ------------------------- | ------ | ------- | ------------------------------------------------------------------------ |
| GET    | `/discovery/search`       | Bearer | 200     | Text and filters; `sort=relevance\|departure\|proximity`. Paged.         |
| GET    | `/discovery/nearby`       | Bearer | 200     | `lat`, `lng` required, optional `radiusKm` and `mode`. Closest first.    |
| GET    | `/discovery/trending`     | Bearer | 200     | Next 60 days, most joins in the last 7 days first. Optional point.       |
| GET    | `/discovery/destinations` | Bearer | 200     | Destinations of upcoming trips, most trips first; `q` matches the start. |

**Search parameters:** `q` (title, places and description; prefix matching), `mode`,
`activityType` (comma-separated), `from` / `to` (part of the meeting point or destination name),
`departFrom` / `departTo` (ISO date-times), `budgetMinPaise` / `budgetMaxPaise` (trips without an
estimate are excluded when set), `minSeats` (open places), `status` (`PUBLISHED` by default; add
`FULL`), `difficulty` (comma-separated), `bikeCategory` (rides that suit that bike or any bike),
`engineCc` (rides whose minimum engine size that bike meets), `lat` / `lng` / `radiusKm`, `sort`,
`limit` (1–50, default 20) and `cursor`.

**Location and privacy:** coordinates must be valid (latitude −90..90, longitude −180..180) and
sent together. `radiusKm` defaults to `DISCOVERY_DEFAULT_RADIUS_KM` (25) and may not exceed
`DISCOVERY_MAX_RADIUS_KM` (200); 500 is the hard limit. A searcher's coordinates are used for that
query only: they are not stored, and request logs record the path without the query string. The
app asks for location permission only when the member taps "Near me", and rounds it to about
100 m first. Without a point, `nearby` returns 400 and `search` works with `straightLineKm: null`.
Meeting points in results are always rounded to about 1 km (`origin.approximate: true`), and
`straightLineKm` is a whole number of at least 1. It is a straight-line distance, never presented
as road distance; the road distance is `route` (Google), when available.

**Ranking (`sort=relevance`)** is a weighted sum of signals, each scaled 0..1 (`RANKING_WEIGHTS`
in `apps/api/src/discovery/discovery.service.ts`):

| Signal      | Weight | Meaning                                                                            |
| ----------- | -----: | ---------------------------------------------------------------------------------- |
| Text match  |      3 | Postgres `ts_rank_cd` of title/destination (A), meeting point (B), description (C) |
| Proximity   |      2 | 1 at the searched point, 0 at the edge of the radius                               |
| Soonness    |      1 | 1 departing now, 0 at 60 days or more                                              |
| Open places |      1 | Share of places still open                                                         |
| Preferences |      1 | Activity or mode matches the member's saved preferences                            |

Ties go to the earlier departure. Nothing about the people on a trip is used. Each card carries
`matchReasons` in plain words (for example "About 4 km away (straight line)", "3 places left").

**Paging:** ranked results shift as time passes, so discovery pages by position with an opaque
`cursor`, up to 500 results deep; narrow the search to see more.

### Maps and media

Optional integrations. Each is off until its server credentials are set, and then returns 503
instead of pretending to work. Keys never reach the apps.

| Method | Path                       | Auth   | Success | Description                                                                  |
| ------ | -------------------------- | ------ | ------- | ---------------------------------------------------------------------------- |
| GET    | `/features`                | Bearer | 200     | `{ placeSearch, routing, coverUploads }`: which integrations are configured. |
| GET    | `/places/autocomplete`     | Bearer | 200     | `q` (2–120 chars), `sessionToken`. Google place suggestions, India only.     |
| GET    | `/places/:placeId`         | Bearer | 200     | `sessionToken`. Name, address and point of a suggestion.                     |
| POST   | `/uploads/cover-signature` | Bearer | 200     | Signed fields for one direct upload of a trip cover to Cloudinary.           |
| POST   | `/uploads/signature`       | Bearer | 200     | `{ kind: trip-cover \| community-cover \| post-photo }`. Same, by kind.      |

Place search is limited to 60 requests per minute per client and biased to Bengaluru. Results are
Google's and the app shows "Results from Google". The upload signature fixes the folder, a random
public id, allowed formats (JPG, PNG, WebP) and strips metadata; the app posts the file straight to
`uploadUrl`, so photos never pass through the API. Saved image ids must be in the member's own
folder for that kind and exist in Cloudinary (checked with the Admin API).

## Success responses

| Case              | Status | Body                                                                  |
| ----------------- | ------ | --------------------------------------------------------------------- |
| Read one resource | 200    | `{ "data": { ... } }`                                                 |
| Create            | 201    | `{ "data": { ... } }` (the created resource)                          |
| List              | 200    | `{ "data": [ ... ], "page": { "nextCursor": "…", "hasMore": true } }` |
| Action, no body   | 204    | empty                                                                 |

Types: `DataResponse<T>`, `PageResponse<T>` and the Zod builders `dataEnvelope` / `pageEnvelope`
in `@voyago/shared`.

## Errors

Every error, from validation to an unexpected crash, has the same shape (`ApiError` in
`@voyago/shared`):

```json
{
  "statusCode": 400,
  "error": "Bad Request",
  "message": "Validation failed",
  "details": [{ "path": "title", "message": "Too small: expected string to have >=3 characters" }],
  "requestId": "6c1f0a4e-7d0e-4c55-9a39-6b7e1f0c2d11",
  "timestamp": "2026-11-20T07:00:00.000Z",
  "path": "/api/v1/trips"
}
```

| Status | When                                                                                   |
| ------ | -------------------------------------------------------------------------------------- |
| 400    | Validation failed (`details` lists each field), malformed JSON, invalid cursor or UUID |
| 401    | Not authenticated (every route that is not explicitly public)                          |
| 403    | Authenticated but not allowed, or signing in to a suspended account                    |
| 404    | Route or record not found                                                              |
| 409    | Conflicts with existing data (duplicate, or related records prevent the change)        |
| 413    | Request body larger than 100 KB                                                        |
| 422    | Valid input that breaks a data rule enforced by the database                           |
| 429    | Rate limit exceeded                                                                    |
| 500    | Unexpected error. The message is always generic                                        |
| 503    | A dependency is down (readiness), or a provider is not configured (SMS, email, Google) |

**No internals leak.** Stack traces, SQL, table, column and constraint names never appear in
responses. Database errors are mapped by `AllExceptionsFilter`: unique violation → 409, foreign key
→ 409, record not found → 404, CHECK constraint or trigger rule → 422, anything else → generic 500.
The full error is logged server-side with the request id.

## Request ids

Every request gets an id, from a well-formed incoming `x-request-id` header (letters, digits, `_`,
`-`, up to 64 characters) or a new UUID. It is returned in the `x-request-id` response header, in
every error body and in every log line for that request. Quote it when reporting a problem.

## Validation

Request bodies, query strings and path parameters are validated with Zod schemas from
`@voyago/shared`, so the apps and the API share one definition.

```ts
// packages/shared: the contract
export const CreateThingSchema = z.object({ title: z.string().min(3).max(120) });

// apps/api: a DTO class from the same schema
export class CreateThingDto extends createZodDto(CreateThingSchema) {}

@Post()
create(@Body() body: CreateThingDto) { ... }          // validated by the global pipe

@Get(':id')
get(@Param('id', new ZodValidationPipe(UuidSchema)) id: string) { ... }
```

- The global `ZodValidationPipe` validates every parameter typed with a `createZodDto` class.
- Unknown properties are stripped, so clients cannot set fields they should not (`role`, `status`).
- Query values arrive as strings; schemas use `z.coerce` for numbers.
- The same schema generates the Swagger documentation for the DTO.

## Pagination

Lists use **cursor (keyset) pagination**, which stays fast and stable while new rows arrive (feeds,
chat, discovery).

| Query param | Type    | Default | Rules                                          |
| ----------- | ------- | ------- | ---------------------------------------------- |
| `limit`     | integer | 20      | 1 to 100                                       |
| `cursor`    | string  | none    | Opaque. Pass back `page.nextCursor` unchanged. |

The first request omits `cursor`. When `page.hasMore` is `false`, `nextCursor` is `null` and there
are no more results. A tampered cursor returns 400. Server side, use `CursorPageQuerySchema`,
`decodeCursor` and `toPage` from `src/common/pagination/cursor.ts`: fetch `limit + 1` rows ordered by
`(created_at DESC, id DESC)` and filter with the decoded cursor.

## Authentication

The API is **secure by default**. A global `AuthGuard` rejects every route with 401 unless it is
marked `@Public()`. Send `Authorization: Bearer <accessToken>`.

```json
// POST /api/v1/auth/login → 200
{
  "data": {
    "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…",
    "expiresIn": 900,
    "refreshToken": "q3V0…43 characters",
    "tokenType": "Bearer"
  }
}
```

- **Access token:** HS256 JWT, 15 minutes (`ACCESS_TOKEN_TTL_SECONDS`). Claims `sub` (user id) and
  `sid` (session family). The guard also checks on every request that the session is still signed
  in and the account is active, so logout and suspension take effect at once.
- **Refresh token:** opaque, 30 days (`REFRESH_TOKEN_TTL_DAYS`), single use. Each refresh returns
  a new pair; store the new refresh token. Presenting an already-used refresh token revokes that
  sign-in on every device that shares it (theft detection), so apps must not refresh in parallel.
- Mobile keeps the refresh token in the Keychain / Keystore and the access token in memory.
- On 401 from a protected route, refresh once and retry; if refresh returns 401, sign in again.
- Phone and social sign-ins return `{ status: "SIGNUP_REQUIRED", signupToken }` for new people;
  finish with `POST /auth/signup/complete`. The signup token lasts 15 minutes.

## Rate limiting

A global limit per client IP (`RATE_LIMIT_MAX` requests per `RATE_LIMIT_TTL_SECONDS`, default 120 per
60 s) returns 429 when exceeded. Health probes are exempt. Sign-in, OTP and recovery routes have a
stricter limit: `AUTH_RATE_LIMIT_MAX` (default 10) per minute per IP for each route. In addition,
10 failed passwords lock that account's password sign-in for 15 minutes, and each phone number can
receive 3 codes per 15 minutes and 10 per day. Each code allows 5 attempts. Behind a load balancer, set
`TRUST_PROXY=true` so the real client IP is used.

## CORS and headers

Allowed browser origins come from `CORS_ORIGINS` (comma-separated). Helmet sets security headers;
`x-powered-by` is removed.

## Versioning

Breaking changes go to a new prefix (`/api/v2`) while `/api/v1` keeps working for released mobile
apps. Additive changes (new fields, new endpoints) stay in v1.
