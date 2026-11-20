# 08 --- Communities and Social Graph

Build community features that encourage repeat participation.

## Communities

Fields: - name - slug - description - cover image - category -
location - visibility: PUBLIC or PRIVATE - owner - moderators - created
date

Features: - create community - edit community - request/join - approve
members for private communities - leave community - appoint moderators -
remove members - list community trips - community announcements

## Social graph

-   follow/unfollow users
-   view public profiles
-   mutual follows where privacy permits
-   block/unblock users

## Activity feed

Start with a chronological feed containing: - trip announcements -
completed trip posts - destination photos - community announcements

Do not build a complex ranking algorithm yet.

## Safety

-   Blocked users cannot initiate direct interactions.
-   Private community content is visible only to authorised members.
-   Report community, post or user.
-   Moderators cannot grant themselves higher privileges.
-   Audit moderator actions.

## UI

Build community discovery, community detail, member list, join state,
community trip list and profile follow controls.

## Tests

Test private access, membership transitions, moderator permissions,
block rules and feed visibility.

## Completion gate

Community creation and membership work securely. Update documentation.
