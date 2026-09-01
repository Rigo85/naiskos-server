ALTER TABLE naiskos.frame_runtime
  ADD COLUMN telemetry_schema_version integer,
  ADD COLUMN last_heartbeat_at timestamptz,
  ADD COLUMN last_full_telemetry_at timestamptz,
  ADD COLUMN observed_at timestamptz,
  ADD COLUMN uptime_seconds bigint,
  ADD COLUMN temperature_c numeric(5,2),
  ADD COLUMN throttled_mask text,
  ADD COLUMN memory_total_bytes bigint,
  ADD COLUMN memory_used_bytes bigint,
  ADD COLUMN memory_available_bytes bigint,
  ADD COLUMN swap_total_bytes bigint,
  ADD COLUMN swap_used_bytes bigint,
  ADD COLUMN telemetry jsonb;

ALTER TABLE naiskos.frame_runtime
  ADD CONSTRAINT frame_runtime_remote_telemetry_nonnegative CHECK (
    (uptime_seconds IS NULL OR uptime_seconds >= 0) AND
    (memory_total_bytes IS NULL OR memory_total_bytes >= 0) AND
    (memory_used_bytes IS NULL OR memory_used_bytes >= 0) AND
    (memory_available_bytes IS NULL OR memory_available_bytes >= 0) AND
    (swap_total_bytes IS NULL OR swap_total_bytes >= 0) AND
    (swap_used_bytes IS NULL OR swap_used_bytes >= 0)
  );

CREATE TABLE naiskos.frame_telemetry_samples (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  frame_id uuid NOT NULL REFERENCES naiskos.frames(id) ON DELETE CASCADE,
  observed_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  temperature_c numeric(5,2),
  throttled_mask text,
  disk_used_percent numeric(5,2) NOT NULL CHECK (disk_used_percent BETWEEN 0 AND 100),
  memory_used_percent numeric(5,2) CHECK (memory_used_percent BETWEEN 0 AND 100),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX frame_telemetry_samples_frame_time_idx
  ON naiskos.frame_telemetry_samples (frame_id, observed_at DESC);
CREATE INDEX frame_runtime_last_seen_idx
  ON naiskos.frame_runtime (last_seen_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON naiskos.frame_telemetry_samples TO naiskos_app;
GRANT USAGE, SELECT ON SEQUENCE naiskos.frame_telemetry_samples_id_seq TO naiskos_app;
