ALTER TABLE naiskos.release_campaigns
  ADD COLUMN expires_at timestamptz DEFAULT (now() + interval '72 hours');

UPDATE naiskos.release_campaigns
   SET expires_at = COALESCE(approved_at, created_at) + interval '72 hours';

ALTER TABLE naiskos.release_campaigns
  ALTER COLUMN expires_at SET NOT NULL,
  ADD CONSTRAINT release_campaigns_expiry_after_creation
    CHECK (expires_at > created_at);

CREATE INDEX release_campaigns_active_expiry_idx
  ON naiskos.release_campaigns (expires_at)
  WHERE status IN ('draft', 'approved', 'paused');
