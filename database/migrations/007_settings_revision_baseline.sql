ALTER TABLE naiskos.frames
  ALTER COLUMN settings_revision SET DEFAULT 1;

UPDATE naiskos.frames
   SET settings_revision = 1,
       manifest_version = manifest_version + 1,
       updated_at = now()
 WHERE settings_revision = 0;
