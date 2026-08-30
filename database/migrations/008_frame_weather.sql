ALTER TABLE naiskos.frames
  ALTER COLUMN settings SET DEFAULT
  '{"photoDurationSeconds":30,"fadeDurationMs":450,"defaultFitMode":"contain","order":"newest","volume":0.5,"muted":false,"showCaption":true,"showSender":true,"showClock":true,"showDate":true,"showWeather":true,"use24Hour":true,"temperatureUnit":"c"}'::jsonb;

UPDATE naiskos.frames
   SET settings =
         '{"showClock":true,"showDate":true,"showWeather":true,"use24Hour":true,"temperatureUnit":"c"}'::jsonb
         || settings,
       settings_revision = settings_revision + 1,
       manifest_version = manifest_version + 1,
       updated_at = now()
 WHERE NOT settings ?& ARRAY[
   'showClock', 'showDate', 'showWeather', 'use24Hour', 'temperatureUnit'
 ];

CREATE TABLE naiskos.frame_locations (
  frame_id uuid PRIMARY KEY REFERENCES naiskos.frames(id) ON DELETE CASCADE,
  mode text NOT NULL DEFAULT 'automatic' CHECK (mode IN ('automatic', 'manual')),
  source text NOT NULL CHECK (source IN ('maxmind', 'manual', 'telegram')),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 240),
  city text,
  subdivision text,
  country_code text NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  timezone text NOT NULL CHECK (length(timezone) BETWEEN 1 AND 80),
  accuracy_radius_km integer CHECK (accuracy_radius_km >= 0),
  candidate jsonb,
  candidate_observations integer NOT NULL DEFAULT 0 CHECK (candidate_observations >= 0),
  candidate_first_seen timestamptz,
  detected_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE naiskos.frame_weather (
  frame_id uuid PRIMARY KEY REFERENCES naiskos.frames(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'open-meteo',
  temperature_c double precision,
  apparent_temperature_c double precision,
  weather_code integer,
  is_day boolean,
  observed_at timestamptz,
  fetched_at timestamptz,
  last_attempt_at timestamptz,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (temperature_c IS NULL AND apparent_temperature_c IS NULL AND
     weather_code IS NULL AND is_day IS NULL AND observed_at IS NULL AND fetched_at IS NULL)
    OR
    (temperature_c IS NOT NULL AND apparent_temperature_c IS NOT NULL AND
     weather_code IS NOT NULL AND is_day IS NOT NULL AND observed_at IS NOT NULL AND fetched_at IS NOT NULL)
  )
);

GRANT SELECT, INSERT, UPDATE, DELETE ON naiskos.frame_locations TO naiskos_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON naiskos.frame_weather TO naiskos_app;
GRANT SELECT ON naiskos.frame_locations TO naiskos_readonly;
GRANT SELECT ON naiskos.frame_weather TO naiskos_readonly;
