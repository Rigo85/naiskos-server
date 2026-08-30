CREATE SCHEMA IF NOT EXISTS naiskos AUTHORIZATION naiskos_owner;

CREATE TABLE naiskos.frames (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('provisioning', 'active', 'disabled')),
  width integer NOT NULL DEFAULT 1280 CHECK (width > 0),
  height integer NOT NULL DEFAULT 800 CHECK (height > 0),
  manifest_version bigint NOT NULL DEFAULT 0 CHECK (manifest_version >= 0),
  settings jsonb NOT NULL DEFAULT '{"photoDurationSeconds":30,"fadeDurationMs":450,"defaultFitMode":"contain","order":"newest","volume":0.5,"muted":false,"showCaption":true,"showSender":true}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE naiskos.agent_tokens (
  id uuid PRIMARY KEY,
  frame_id uuid NOT NULL REFERENCES naiskos.frames(id) ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  label text NOT NULL DEFAULT 'primary',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

CREATE TABLE naiskos.telegram_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id text NOT NULL UNIQUE,
  display_name text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'blocked')),
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE naiskos.telegram_updates (
  update_id bigint PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);

CREATE TABLE naiskos.frame_memberships (
  frame_id uuid NOT NULL REFERENCES naiskos.frames(id) ON DELETE CASCADE,
  telegram_user_id uuid NOT NULL REFERENCES naiskos.telegram_users(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('approved', 'revoked')),
  remember_target boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (frame_id, telegram_user_id)
);

CREATE TABLE naiskos.frame_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  frame_id uuid NOT NULL REFERENCES naiskos.frames(id) ON DELETE CASCADE,
  code_hash bytea NOT NULL UNIQUE CHECK (octet_length(code_hash) = 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  CHECK (expires_at > created_at)
);

CREATE TABLE naiskos.pending_selections (
  code text PRIMARY KEY,
  telegram_user_id uuid NOT NULL REFERENCES naiskos.telegram_users(id) ON DELETE CASCADE,
  payload jsonb NOT NULL,
  allowed_frame_ids uuid[] NOT NULL,
  selected_frame_ids uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  consumed_at timestamptz
);

CREATE TABLE naiskos.frame_runtime (
  frame_id uuid PRIMARY KEY REFERENCES naiskos.frames(id) ON DELETE CASCADE,
  installed_version bigint NOT NULL DEFAULT 0,
  agent_state text NOT NULL DEFAULT 'unconfigured',
  disk_used_percent numeric(5,2),
  last_error text,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  last_sync_at timestamptz
);

CREATE TABLE naiskos.device_events (
  id uuid PRIMARY KEY,
  frame_id uuid NOT NULL REFERENCES naiskos.frames(id) ON DELETE CASCADE,
  kind text NOT NULL,
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE naiskos.media (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('photo', 'video')),
  status text NOT NULL CHECK (status IN ('processing', 'ready', 'rejected', 'failed')),
  source text NOT NULL DEFAULT 'telegram',
  source_unique_id text,
  sender_telegram_user_id uuid REFERENCES naiskos.telegram_users(id) ON DELETE SET NULL,
  caption text CHECK (caption IS NULL OR length(caption) <= 1024),
  original_delete_after timestamptz,
  rejection_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, source_unique_id)
);

CREATE TABLE naiskos.media_variants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  media_id uuid NOT NULL REFERENCES naiskos.media(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('original', 'display', 'poster')),
  width integer,
  height integer,
  duration_seconds numeric(10,3),
  mime_type text NOT NULL,
  extension text NOT NULL CHECK (extension ~ '^\.[a-z0-9]{2,5}$'),
  sha256 bytea NOT NULL CHECK (octet_length(sha256) = 32),
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  storage_path text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (media_id, purpose)
);

CREATE INDEX media_variants_hash_idx ON naiskos.media_variants (sha256);

CREATE TABLE naiskos.frame_media (
  frame_id uuid NOT NULL REFERENCES naiskos.frames(id) ON DELETE CASCADE,
  media_id uuid NOT NULL REFERENCES naiskos.media(id) ON DELETE CASCADE,
  variant_id uuid NOT NULL REFERENCES naiskos.media_variants(id),
  poster_variant_id uuid REFERENCES naiskos.media_variants(id),
  fit_mode text NOT NULL DEFAULT 'inherit' CHECK (fit_mode IN ('inherit', 'contain', 'cover')),
  position bigint NOT NULL DEFAULT 0,
  added_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  purge_after timestamptz,
  PRIMARY KEY (frame_id, media_id)
);

CREATE INDEX frame_media_active_idx ON naiskos.frame_media (frame_id, position, added_at DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE naiskos.jobs (
  id uuid PRIMARY KEY,
  kind text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL,
  locked_at timestamptz,
  locked_by text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX jobs_claim_idx ON naiskos.jobs (available_at, created_at) WHERE status = 'pending';

CREATE TABLE naiskos.audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  frame_id uuid REFERENCES naiskos.frames(id) ON DELETE SET NULL,
  actor_telegram_user_id uuid REFERENCES naiskos.telegram_users(id) ON DELETE SET NULL,
  action text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_frame_time_idx ON naiskos.audit_log (frame_id, created_at DESC);
CREATE INDEX audit_log_retention_idx ON naiskos.audit_log (created_at);

GRANT USAGE ON SCHEMA naiskos TO naiskos_app, naiskos_readonly;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA naiskos TO naiskos_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA naiskos TO naiskos_app;
GRANT SELECT ON ALL TABLES IN SCHEMA naiskos TO naiskos_readonly;

ALTER DEFAULT PRIVILEGES FOR ROLE naiskos_owner IN SCHEMA naiskos
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO naiskos_app;
ALTER DEFAULT PRIVILEGES FOR ROLE naiskos_owner IN SCHEMA naiskos
  GRANT USAGE, SELECT ON SEQUENCES TO naiskos_app;
ALTER DEFAULT PRIVILEGES FOR ROLE naiskos_owner IN SCHEMA naiskos
  GRANT SELECT ON TABLES TO naiskos_readonly;
