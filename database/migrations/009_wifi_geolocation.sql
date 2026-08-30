ALTER TABLE naiskos.frame_locations
  DROP CONSTRAINT frame_locations_source_check;

ALTER TABLE naiskos.frame_locations
  ADD CONSTRAINT frame_locations_source_check
  CHECK (source IN ('google_wifi', 'maxmind', 'manual', 'telegram'));

ALTER TABLE naiskos.frame_locations
  ALTER COLUMN accuracy_radius_km TYPE double precision;

DELETE FROM naiskos.frame_weather
 WHERE frame_id IN (
   SELECT frame_id
     FROM naiskos.frame_locations
    WHERE mode = 'automatic' AND source = 'maxmind'
 );

DELETE FROM naiskos.frame_locations
 WHERE mode = 'automatic' AND source = 'maxmind';
