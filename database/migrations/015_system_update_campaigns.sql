CREATE TABLE naiskos.system_update_campaigns (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('general')),
  period text NOT NULL CHECK (period ~ '^[0-9]{4}-[0-9]{2}$'),
  status text NOT NULL DEFAULT 'approved'
    CHECK (status IN ('approved', 'paused', 'cancelled', 'completed')),
  timezone text NOT NULL DEFAULT 'America/Lima',
  active_stage text NOT NULL DEFAULT 'pilot'
    CHECK (active_stage IN ('pilot', 'ten-percent', 'remainder')),
  maintenance_from time NOT NULL DEFAULT '00:00',
  maintenance_until time NOT NULL DEFAULT '06:00',
  observe_minutes integer NOT NULL DEFAULT 60
    CHECK (observe_minutes BETWEEN 1 AND 10080),
  failure_threshold_percent numeric(5,2) NOT NULL DEFAULT 5
    CHECK (failure_threshold_percent > 0 AND failure_threshold_percent <= 100),
  scheduled_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (kind, period)
);

CREATE TABLE naiskos.system_update_assignments (
  campaign_id uuid NOT NULL REFERENCES naiskos.system_update_campaigns(id) ON DELETE CASCADE,
  frame_id uuid NOT NULL REFERENCES naiskos.frames(id) ON DELETE CASCADE,
  stage text NOT NULL
    CHECK (stage IN ('pilot', 'ten-percent', 'remainder')),
  status text NOT NULL DEFAULT 'assigned'
    CHECK (status IN ('assigned', 'running', 'observing', 'installed', 'failed')),
  packages_changed integer CHECK (packages_changed IS NULL OR packages_changed >= 0),
  reboot_required boolean,
  last_error text,
  started_at timestamptz,
  observed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, frame_id)
);

CREATE INDEX system_update_assignments_frame_status_idx
  ON naiskos.system_update_assignments (frame_id, status, updated_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON
  naiskos.system_update_campaigns,
  naiskos.system_update_assignments
TO naiskos_app;
