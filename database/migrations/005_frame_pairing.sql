CREATE TABLE naiskos.frame_pairing_codes (
  frame_id uuid PRIMARY KEY REFERENCES naiskos.frames(id) ON DELETE CASCADE,
  code_hash bytea NOT NULL UNIQUE CHECK (octet_length(code_hash)=32),
  created_at timestamptz NOT NULL DEFAULT now(),
  rotated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX frame_pairing_codes_rotated_idx
  ON naiskos.frame_pairing_codes (rotated_at);

CREATE TABLE naiskos.frame_pairing_claims (
  frame_id uuid NOT NULL REFERENCES naiskos.frames(id) ON DELETE CASCADE,
  telegram_user_id uuid NOT NULL REFERENCES naiskos.telegram_users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  PRIMARY KEY (frame_id, telegram_user_id),
  CHECK (expires_at > created_at)
);

CREATE INDEX frame_pairing_claims_user_expiry_idx
  ON naiskos.frame_pairing_claims (telegram_user_id, expires_at);
