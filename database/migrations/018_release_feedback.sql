-- Transactional events: emitted only when the authoritative state changes.
ALTER TABLE naiskos.release_assignments ADD COLUMN health_confirmed boolean NOT NULL DEFAULT false;
CREATE TABLE naiskos.release_feedback_events (
  id bigserial PRIMARY KEY,
  campaign_id uuid NOT NULL REFERENCES naiskos.release_campaigns(id) ON DELETE CASCADE,
  details jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE naiskos.release_feedback_deliveries (
  campaign_id uuid NOT NULL REFERENCES naiskos.release_campaigns(id) ON DELETE CASCADE,
  chat_id text NOT NULL,
  delivery_key text NOT NULL,
  message_id bigint,
  fingerprint text,
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  last_error text,
  PRIMARY KEY (campaign_id, chat_id, delivery_key)
);
CREATE FUNCTION naiskos.capture_release_feedback() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE release text; frame_name text;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  IF TG_TABLE_NAME = 'release_assignments' THEN
    -- Successful frames remain visible in the canonical message. Notify once
    -- when the whole campaign completes, not twice for a single-frame pilot.
    IF NEW.status NOT IN ('failed','rolled_back') THEN RETURN NEW; END IF;
    SELECT release_id INTO release FROM naiskos.release_campaigns WHERE id=NEW.campaign_id;
    SELECT name INTO frame_name FROM naiskos.frames WHERE id=NEW.frame_id;
    INSERT INTO naiskos.release_feedback_events(campaign_id,details) VALUES
      (NEW.campaign_id,jsonb_build_object('releaseId',release,'status',NEW.status,
       'frameName',frame_name,'frameId',NEW.frame_id,'error',NEW.last_error));
  ELSE
    IF NEW.status NOT IN ('paused','cancelled','completed') THEN RETURN NEW; END IF;
    INSERT INTO naiskos.release_feedback_events(campaign_id,details) VALUES
      (NEW.id,jsonb_build_object('releaseId',NEW.release_id,'status',NEW.status,
       'expired',NEW.status='cancelled' AND NEW.expires_at<=now(),
       'hasFailures',NEW.status='paused' AND EXISTS
         (SELECT 1 FROM naiskos.release_assignments WHERE campaign_id=NEW.id AND status IN ('failed','rolled_back'))));
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER release_assignment_feedback AFTER UPDATE OF status ON naiskos.release_assignments
  FOR EACH ROW EXECUTE FUNCTION naiskos.capture_release_feedback();
CREATE TRIGGER release_campaign_feedback AFTER UPDATE OF status ON naiskos.release_campaigns
  FOR EACH ROW EXECUTE FUNCTION naiskos.capture_release_feedback();
GRANT SELECT,INSERT,UPDATE,DELETE ON naiskos.release_feedback_events,naiskos.release_feedback_deliveries TO naiskos_app;
GRANT USAGE,SELECT ON SEQUENCE naiskos.release_feedback_events_id_seq TO naiskos_app;
