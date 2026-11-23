-- Bulk data for load tests: run ONLY against a scratch database (never staging or production).
--   psql "$PERF_DATABASE_URL" -v users=20000 -v trips=50000 -f scripts/perf/seed-volume.sql
-- Members are named perf_*; trips are spread over Bengaluru (70%) and the rest of India.
\set ON_ERROR_STOP on
\if :{?users} \else \set users 20000 \endif
\if :{?trips} \else \set trips 50000 \endif

BEGIN;
INSERT INTO users (username, display_name, home_city, updated_at, last_active_at)
SELECT 'perf_' || g, 'Perf member ' || g,
       (ARRAY['Bengaluru','Mysuru','Chennai','Pune','Mumbai'])[1 + g % 5],
       now(), now() - (g % 40) * interval '1 day'
FROM generate_series(1, :users) g
ON CONFLICT (username) DO NOTHING;

CREATE TEMP TABLE perf_people AS
SELECT id, row_number() OVER (ORDER BY username) AS n FROM users WHERE username LIKE 'perf\_%';

INSERT INTO trips (organiser_id, mode, activity_type, status, title, origin_name, destination_name,
                   departure_at, max_participants, approval_required, published_at, updated_at,
                   origin, destination, difficulty)
SELECT p.id,
       CASE WHEN g % 2 = 0 THEN 'RIDE'::"TripMode" ELSE 'TRAVEL'::"TripMode" END,
       CASE WHEN g % 2 = 0 THEN 'MOTORCYCLE_RIDE'::"ActivityType" ELSE 'ROAD_TRIP'::"ActivityType" END,
       'PUBLISHED', 'Perf trip ' || g, 'Start ' || (g % 300), 'Place ' || (g % 900),
       now() + (1 + g % 60) * interval '1 day' + (g % 24) * interval '1 hour',
       2 + g % 18, g % 3 <> 0, now() - (g % 30) * interval '1 day', now(),
       ST_SetSRID(ST_MakePoint(
         CASE WHEN g % 10 < 7 THEN 77.45 + random() * 0.35 ELSE 72.8 + random() * 15 END,
         CASE WHEN g % 10 < 7 THEN 12.85 + random() * 0.3 ELSE 9 + random() * 19 END), 4326)::geography,
       ST_SetSRID(ST_MakePoint(74 + random() * 6, 11 + random() * 5), 4326)::geography,
       (ARRAY['EASY','MODERATE','CHALLENGING']::"TripDifficulty"[])[1 + g % 3]
FROM generate_series(1, :trips) g
JOIN perf_people p ON p.n = 1 + (g % (SELECT count(*) FROM perf_people));

INSERT INTO trip_participants (trip_id, user_id, role, updated_at)
SELECT t.id, t.organiser_id, 'ORGANISER', now()
FROM trips t JOIN perf_people p ON p.id = t.organiser_id
ON CONFLICT DO NOTHING;
COMMIT;
ANALYZE users; ANALYZE trips; ANALYZE trip_participants;
SELECT (SELECT count(*) FROM users) AS users, (SELECT count(*) FROM trips) AS trips;
