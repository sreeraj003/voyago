# 06 --- Trip Discovery and Geospatial Search

Implement discovery for rides and travel experiences.

## Search requirements

Support: - activity type - Ride or Travel mode - origin - destination -
date range - budget range - participant capacity/available seats - trip
status - public visibility - distance from a coordinate - bike category
where relevant - sort by relevance, departure date or proximity

## Geospatial requirements

Use PostGIS for nearby trip discovery. - Validate latitude/longitude
ranges. - Require explicit location permission from the user. - Never
expose a user's precise home/current location in public results. -
Return trip origin/destination at the precision intended by the
organiser. - Use a configurable search radius. - Add spatial indexes. -
Do not calculate routes using straight-line distance and label it road
distance.

## API

Implement: - GET `/api/v1/discovery/search` - GET
`/api/v1/discovery/nearby` - GET `/api/v1/discovery/trending` - GET
`/api/v1/discovery/destinations`

Use pagination, input validation and sensible query limits.

## Mobile UI

-   Search bar.
-   Filter sheet.
-   List/map toggle.
-   Trip cards.
-   Empty state.
-   Loading skeleton.
-   Search history only if privacy-safe and useful.
-   Clear filters action.

## Ranking

Start with transparent rule-based ranking: - text relevance -
proximity - departure date - available capacity - user-selected activity
preferences

Do not use sensitive attributes to rank people.

## Tests

Test coordinate validation, radius limits, private trip exclusion,
pagination, sorting, and no-location-permission behaviour.

## Completion gate

Users can reliably discover relevant public trips and nearby
experiences. Query plans and indexes are reviewed. Update docs and
progress.
