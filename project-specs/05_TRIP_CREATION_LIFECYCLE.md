# 05 --- Trip and Ride Creation Lifecycle

Implement the core trip engine for both Ride and Travel modes.

## Trip types

1.  `COMMUNITY_FREE`: free community experience. Participants arrange
    and pay their own expenses independently.
2.  `COMMERCIAL_PAID`: commercial package published by an appropriately
    verified operator. Do not implement payment in this milestone.

Do not support paid passenger seats, driver matching or ride-hailing.

## Trip fields

-   title
-   description
-   activity type
-   ride/travel mode
-   cover image
-   origin
-   destination
-   ordered stops
-   departure and return dates
-   max/min participants
-   estimated distance/duration
-   estimated budget and currency
-   visibility: PUBLIC or PRIVATE
-   approval_required
-   organiser
-   status

## Trip lifecycle

DRAFT → PUBLISHED → FULL / IN_PROGRESS → COMPLETED Alternative terminal
states: CANCELLED, EXPIRED.

Enforce valid transitions in backend services. Do not trust frontend
status values.

## Create/edit/publish

-   Authenticated users can create community trips.
-   Organiser can edit their own trip.
-   Organiser can publish, cancel and manage their own trip.
-   Admin can moderate according to role.
-   Validate dates, participant limits, required locations and activity
    type.
-   Do not allow departure dates in the past when publishing.
-   Prevent editing critical trip fields after the trip starts.

## Stops and route

-   Support ordered intermediate stops.
-   Validate coordinates.
-   Store route metadata separately from user live-location data.
-   Do not claim route distance or travel time unless supplied by a
    trusted routing provider.

## UI

Build: - Create trip flow. - Ride/travel mode selector. - Trip details
form. - Date/time selection. - Stops editor. - Participant settings. -
Preview and publish. - Trip detail screen. - Edit and cancel flows.

## Tests

-   Organiser ownership.
-   Invalid dates.
-   Invalid capacity.
-   Invalid state transitions.
-   Editing after start.
-   Public/private access.
-   Free vs commercial type separation.

## Completion gate

A user can create, publish, view, edit and cancel a community trip. All
lifecycle rules are enforced by the backend. Update API docs and
progress.
