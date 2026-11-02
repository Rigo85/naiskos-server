-- Only the small OS-maintenance stream needs ordering lookups. Do not index
-- large media/diagnostic JSON payloads or scan every viewer event per check.
CREATE INDEX device_events_system_update_order_idx
  ON naiskos.device_events (frame_id, kind, occurred_at DESC)
  WHERE kind IN ('system.updates.checked', 'system.maintenance.status');
