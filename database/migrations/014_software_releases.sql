CREATE TABLE naiskos.software_releases (
  release_id text PRIMARY KEY CHECK (release_id ~ '^[0-9]{8}[A-Za-z0-9._-]{1,80}$'),
  manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'object'),
  manifest_path text NOT NULL,
  signature_path text NOT NULL,
  archive_path text NOT NULL,
  archive_size_bytes bigint NOT NULL CHECK (archive_size_bytes > 0),
  archive_sha256 text NOT NULL CHECK (archive_sha256 ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'published'
    CHECK (status IN ('published', 'revoked')),
  published_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE TABLE naiskos.release_campaigns (
  id uuid PRIMARY KEY,
  release_id text NOT NULL REFERENCES naiskos.software_releases(release_id),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'approved', 'paused', 'cancelled', 'completed')),
  timezone text NOT NULL DEFAULT 'America/Lima',
  active_stage text NOT NULL DEFAULT 'pilot'
    CHECK (active_stage IN ('pilot', 'ten-percent', 'remainder')),
  maintenance_from time NOT NULL DEFAULT '00:00',
  maintenance_until time NOT NULL DEFAULT '06:00',
  observe_minutes integer NOT NULL DEFAULT 60 CHECK (observe_minutes BETWEEN 1 AND 10080),
  failure_threshold_percent numeric(5,2) NOT NULL DEFAULT 5
    CHECK (failure_threshold_percent > 0 AND failure_threshold_percent <= 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  completed_at timestamptz,
  created_by text,
  approved_by text
);

CREATE TABLE naiskos.release_assignments (
  campaign_id uuid NOT NULL REFERENCES naiskos.release_campaigns(id) ON DELETE CASCADE,
  frame_id uuid NOT NULL REFERENCES naiskos.frames(id) ON DELETE CASCADE,
  stage text NOT NULL DEFAULT 'pilot'
    CHECK (stage IN ('pilot', 'ten-percent', 'remainder')),
  status text NOT NULL DEFAULT 'assigned'
    CHECK (status IN (
      'assigned', 'downloading', 'verified', 'awaiting_window', 'activating',
      'observing', 'installed', 'failed', 'rolled_back'
    )),
  progress_percent numeric(5,2) CHECK (progress_percent BETWEEN 0 AND 100),
  last_error text,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  downloaded_at timestamptz,
  activated_at timestamptz,
  observed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, frame_id)
);

CREATE INDEX release_assignments_frame_status_idx
  ON naiskos.release_assignments (frame_id, status, assigned_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON
  naiskos.software_releases,
  naiskos.release_campaigns,
  naiskos.release_assignments
TO naiskos_app;
