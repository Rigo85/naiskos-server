ALTER TABLE naiskos.media_variants
  ADD COLUMN rotation_degrees integer NOT NULL DEFAULT 0
  CHECK (rotation_degrees IN (0, 90, 180, 270));

ALTER TABLE naiskos.media_variants
  DROP CONSTRAINT media_variants_media_id_purpose_key;

ALTER TABLE naiskos.media_variants
  ADD CONSTRAINT media_variants_media_purpose_rotation_key
  UNIQUE (media_id, purpose, rotation_degrees);

ALTER TABLE naiskos.frame_media
  ADD COLUMN rotation_degrees integer NOT NULL DEFAULT 0
  CHECK (rotation_degrees IN (0, 90, 180, 270));

ALTER TABLE naiskos.frames
  ADD COLUMN settings_revision bigint NOT NULL DEFAULT 0
  CHECK (settings_revision >= 0);

CREATE INDEX jobs_media_rotation_idx
  ON naiskos.jobs ((payload->>'frameId'), (payload->>'mediaId'), created_at)
  WHERE kind = 'media.rotate' AND status IN ('pending', 'running');
