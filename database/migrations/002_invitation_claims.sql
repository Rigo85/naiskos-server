ALTER TABLE naiskos.frame_invitations
  ADD COLUMN claimed_by_telegram_user_id uuid
    REFERENCES naiskos.telegram_users(id) ON DELETE SET NULL,
  ADD COLUMN claimed_at timestamptz,
  ADD CONSTRAINT frame_invitations_claim_pair_chk CHECK (
    (claimed_by_telegram_user_id IS NULL) = (claimed_at IS NULL)
  );

CREATE INDEX frame_invitations_claimed_user_idx
  ON naiskos.frame_invitations (claimed_by_telegram_user_id, expires_at)
  WHERE used_at IS NULL AND claimed_by_telegram_user_id IS NOT NULL;
