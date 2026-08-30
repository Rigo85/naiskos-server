ALTER TABLE naiskos.frames
  ADD COLUMN hardware_fingerprint bytea UNIQUE
    CHECK (hardware_fingerprint IS NULL OR octet_length(hardware_fingerprint)=32);

CREATE TABLE naiskos.device_enrollments (
  id uuid PRIMARY KEY,
  hardware_fingerprint bytea NOT NULL CHECK (octet_length(hardware_fingerprint)=32),
  token_hash bytea NOT NULL CHECK (octet_length(token_hash)=32),
  claim_code_hash bytea NOT NULL UNIQUE CHECK (octet_length(claim_code_hash)=32),
  device_model text NOT NULL CHECK (length(device_model) BETWEEN 1 AND 120),
  suggested_name text NOT NULL CHECK (length(suggested_name) BETWEEN 1 AND 120),
  width integer NOT NULL CHECK (width BETWEEN 1 AND 16384),
  height integer NOT NULL CHECK (height BETWEEN 1 AND 16384),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  frame_id uuid UNIQUE REFERENCES naiskos.frames(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  resolved_at timestamptz,
  resolved_by_telegram_id text,
  CHECK (expires_at > created_at),
  CHECK ((status='pending') = (resolved_at IS NULL)),
  CHECK ((status='approved') = (frame_id IS NOT NULL))
);

CREATE UNIQUE INDEX device_enrollments_pending_hardware_idx
  ON naiskos.device_enrollments (hardware_fingerprint)
  WHERE status='pending';

CREATE INDEX device_enrollments_expiry_idx
  ON naiskos.device_enrollments (expires_at)
  WHERE status='pending';
