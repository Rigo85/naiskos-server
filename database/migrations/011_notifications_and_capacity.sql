CREATE TABLE naiskos.frame_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  frame_id uuid NOT NULL REFERENCES naiskos.frames(id) ON DELETE CASCADE,
  kind text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('info', 'warning', 'error')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  message text NOT NULL CHECK (length(message) BETWEEN 1 AND 1000),
  dedupe_key text NOT NULL CHECK (length(dedupe_key) BETWEEN 1 AND 200),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  dismissed_at timestamptz,
  resolved_at timestamptz,
  UNIQUE (frame_id, dedupe_key)
);

CREATE INDEX frame_notifications_visible_idx
  ON naiskos.frame_notifications (frame_id, created_at DESC)
  WHERE dismissed_at IS NULL;

ALTER TABLE naiskos.frame_media
  ADD COLUMN sync_status text NOT NULL DEFAULT 'active'
    CHECK (sync_status IN ('active', 'pending_capacity'));

CREATE INDEX frame_media_pending_capacity_idx
  ON naiskos.frame_media (frame_id, added_at)
  WHERE deleted_at IS NULL AND sync_status = 'pending_capacity';

GRANT SELECT, INSERT, UPDATE, DELETE ON naiskos.frame_notifications TO naiskos_app;

