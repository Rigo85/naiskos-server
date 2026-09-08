ALTER TABLE naiskos.system_update_campaigns
  ADD COLUMN expires_at timestamptz;

UPDATE naiskos.system_update_campaigns
   SET expires_at = scheduled_at + interval '7 days'
 WHERE expires_at IS NULL;

ALTER TABLE naiskos.system_update_campaigns
  ALTER COLUMN expires_at SET NOT NULL,
  ALTER COLUMN expires_at SET DEFAULT (now() + interval '7 days');

ALTER TABLE naiskos.system_update_assignments
  DROP CONSTRAINT system_update_assignments_status_check;

ALTER TABLE naiskos.system_update_assignments
  ADD CONSTRAINT system_update_assignments_status_check
  CHECK (status IN (
    'assigned', 'running', 'deferred', 'reboot_pending', 'verifying',
    'observing', 'installed', 'failed'
  ));

ALTER TABLE naiskos.system_update_assignments
  ADD COLUMN attempt_id uuid,
  ADD COLUMN last_attempt_at timestamptz,
  ADD COLUMN verified_at timestamptz;

UPDATE naiskos.system_update_assignments
   SET attempt_id = gen_random_uuid()
 WHERE attempt_id IS NULL;

ALTER TABLE naiskos.system_update_assignments
  ALTER COLUMN attempt_id SET NOT NULL,
  ALTER COLUMN attempt_id SET DEFAULT gen_random_uuid();

CREATE INDEX system_update_campaigns_expiry_idx
  ON naiskos.system_update_campaigns (status, expires_at);

CREATE INDEX system_update_assignments_attempt_idx
  ON naiskos.system_update_assignments (attempt_id);
