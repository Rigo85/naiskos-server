import { randomBytes, randomUUID } from "node:crypto";
import { PoolClient } from "pg";

import { Database, oneOrNull, transaction } from "./db.js";
import { tokenHash } from "./security.js";
import { AutomaticLocation } from "./geo-location.js";
import {
  resolveFrameNotification,
  upsertFrameNotification,
} from "./notifications.js";
import { FullTelemetry, HeartbeatTelemetry } from "./telemetry.js";
import { queueTelegramMediaNotice } from "./telegram-media-notifications.js";

export interface AuthenticatedFrame {
  id: string;
  name: string;
  width: number;
  height: number;
}

export interface TelegramUser {
  id: string;
  telegramId: string;
  status: "pending" | "approved" | "rejected" | "blocked" | "revoked";
}

export interface IngestJobPayload {
  chatId: string;
  telegramFileId: string;
  telegramFileUniqueId: string;
  kind: "photo" | "video";
  mimeType: string | null;
  originalName: string | null;
  sizeBytes: number | null;
  durationSeconds: number | null;
  caption: string | null;
  senderName: string;
  telegramUserId: string;
  frameIds: string[];
}

export interface RotateMediaJobPayload {
  frameId: string;
  mediaId: string;
  rotationDegrees: 0 | 90 | 180 | 270;
  deviceEventId: string;
}

export interface PendingSelection {
  code: string;
  payload: IngestJobPayload;
  allowedFrameIds: string[];
  selectedFrameIds: string[];
}

export interface InvitationResult {
  frameId: string;
  frameName: string;
}

export interface TelegramApprovalResult {
  approved: boolean;
  grantedFrames: InvitationResult[];
}

export interface DeviceEnrollmentInput {
  requestId: string;
  hardwareFingerprint: Buffer;
  tokenHash: Buffer;
  claimCodeHash: Buffer;
  deviceModel: string;
  suggestedName: string;
  width: number;
  height: number;
}

export interface AutomaticDeviceEnrollmentInput {
  hardwareFingerprint: Buffer;
  tokenHash: Buffer;
  pairingCodeHash: Buffer;
  deviceModel: string;
  suggestedName: string;
  width: number;
  height: number;
}

export interface AutomaticDeviceEnrollmentResult {
  frameId: string;
  frameName: string;
  created: boolean;
}

export interface FrameWeatherRecord {
  location: (AutomaticLocation & {
    source: "google_wifi" | "maxmind" | "manual" | "telegram";
  }) | null;
  weather: {
    temperatureC: number;
    apparentTemperatureC: number;
    weatherCode: number;
    isDay: boolean;
    observedAt: string;
    fetchedAt: string;
  } | null;
  lastError: string | null;
}

export interface FrameNotificationRecord {
  id: string;
  kind: string;
  severity: "info" | "warning" | "error";
  title: string;
  message: string;
  createdAt: Date;
  updatedAt: Date;
  readAt: Date | null;
  resolvedAt: Date | null;
}

export interface DeviceEnrollmentSummary {
  requestId: string;
  status: "pending" | "approved" | "rejected" | "expired";
  deviceModel: string;
  suggestedName: string;
  width: number;
  height: number;
  expiresAt: string;
  frameId: string | null;
  frameName: string | null;
}

export interface DeviceEnrollmentMutationResult {
  changed: boolean;
  status: DeviceEnrollmentSummary["status"] | "missing" | "already_enrolled";
  frameId?: string;
  frameName?: string;
}

export interface TelemetryAlertTransition {
  frameId: string;
  frameName: string;
  status: "opened" | "resolved";
  severity: "info" | "warning" | "error";
  kind: string;
  title: string;
  message: string;
}

export interface FleetFrameStatus {
  id: string;
  name: string;
  frameStatus: string;
  agentState: string | null;
  lastSeenAt: Date | null;
  lastFullTelemetryAt: Date | null;
  temperatureC: number | null;
  diskUsedPercent: number | null;
  memoryUsedPercent: number | null;
  releaseId: string | null;
  manifestVersion: number;
  activeAlerts: number;
}

export interface FleetAlert {
  id: string;
  frameId: string;
  frameName: string;
  kind: string;
  severity: "info" | "warning" | "error";
  title: string;
  message: string;
  createdAt: Date;
}

export interface SoftwareAssignment {
  campaignId: string;
  releaseId: string;
  status: string;
  timezone: string;
  maintenanceFrom: string;
  maintenanceUntil: string;
  observeMinutes: number;
  expiresAt: Date;
  manifest: Record<string, unknown>;
  manifestPath: string;
  signaturePath: string;
  archivePath: string;
  archiveSizeBytes: number;
  archiveSha256: string;
}

export interface ReleaseCampaignSummary {
  id: string;
  releaseId: string;
  status: "draft" | "approved" | "paused" | "cancelled" | "completed";
  frames: number;
  installed: number;
  failed: number;
  createdAt: Date;
  expiresAt: Date;
}

export interface SystemUpdatePermit {
  campaignId: string;
  attemptId: string;
  kind: "general";
  period: string;
  timezone: string;
  maintenanceFrom: string;
  maintenanceUntil: string;
  expiresAt: Date;
}

export interface SystemUpdateCampaignSummary {
  id: string;
  period: string;
  status: "approved" | "paused" | "cancelled" | "completed";
  activeStage: "pilot" | "ten-percent" | "remainder";
  frames: number;
  installed: number;
  failed: number;
  scheduledAt: Date;
  expiresAt: Date;
}

export class Repository {
  constructor(private readonly database: Database) {}

  async authenticateFrame(token: string): Promise<AuthenticatedFrame | null> {
    const result = await this.database.query<AuthenticatedFrame>(
      `SELECT f.id, f.name, f.width, f.height
         FROM naiskos.agent_tokens t
         JOIN naiskos.frames f ON f.id = t.frame_id
        WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND f.status = 'active'`,
      [tokenHash(token)],
    );
    return oneOrNull(result.rows);
  }

  async getDesiredSoftware(frameId: string): Promise<SoftwareAssignment | null> {
    const result = await this.database.query<SoftwareAssignment>(
      `SELECT a.campaign_id AS "campaignId", r.release_id AS "releaseId",
              a.status, c.timezone,
              to_char(c.maintenance_from, 'HH24:MI') AS "maintenanceFrom",
              to_char(c.maintenance_until, 'HH24:MI') AS "maintenanceUntil",
              c.observe_minutes AS "observeMinutes", c.expires_at AS "expiresAt",
              r.manifest,
              r.manifest_path AS "manifestPath",
              r.signature_path AS "signaturePath",
              r.archive_path AS "archivePath",
              r.archive_size_bytes AS "archiveSizeBytes",
              r.archive_sha256 AS "archiveSha256"
         FROM naiskos.release_assignments a
         JOIN naiskos.release_campaigns c ON c.id=a.campaign_id
         JOIN naiskos.software_releases r ON r.release_id=c.release_id
        WHERE a.frame_id=$1 AND c.status='approved' AND r.status='published'
          AND c.expires_at > now()
          AND a.status IN ('assigned','downloading','verified','awaiting_window')
          AND CASE a.stage
                WHEN 'pilot' THEN 1 WHEN 'ten-percent' THEN 2 ELSE 3
              END <= CASE c.active_stage
                WHEN 'pilot' THEN 1 WHEN 'ten-percent' THEN 2 ELSE 3
              END
        ORDER BY a.assigned_at DESC LIMIT 1`,
      [frameId],
    );
    return oneOrNull(result.rows);
  }

  async softwareAssetForFrame(
    frameId: string,
    releaseId: string,
    kind: "manifest" | "signature" | "archive",
  ): Promise<string | null> {
    const column = {
      manifest: "r.manifest_path",
      signature: "r.signature_path",
      archive: "r.archive_path",
    }[kind];
    const result = await this.database.query<{ assetPath: string }>(
      `SELECT ${column} AS "assetPath"
         FROM naiskos.release_assignments a
         JOIN naiskos.release_campaigns c ON c.id=a.campaign_id
         JOIN naiskos.software_releases r ON r.release_id=c.release_id
        WHERE a.frame_id=$1 AND r.release_id=$2
          AND c.status='approved' AND c.expires_at > now()
          AND r.status='published'
        ORDER BY a.assigned_at DESC LIMIT 1`,
      [frameId, releaseId],
    );
    return result.rows[0]?.assetPath ?? null;
  }

  async listReleaseCampaigns(): Promise<ReleaseCampaignSummary[]> {
    const result = await this.database.query<ReleaseCampaignSummary>(
      `SELECT c.id, c.release_id AS "releaseId", c.status,
              c.created_at AS "createdAt", c.expires_at AS "expiresAt",
              count(a.frame_id)::integer AS frames,
              count(*) FILTER (WHERE a.status='installed')::integer AS installed,
              count(*) FILTER (WHERE a.status IN ('failed','rolled_back'))::integer AS failed
         FROM naiskos.release_campaigns c
         LEFT JOIN naiskos.release_assignments a ON a.campaign_id=c.id
        GROUP BY c.id ORDER BY c.created_at DESC LIMIT 20`,
    );
    return result.rows;
  }

  async transitionReleaseCampaign(
    campaignId: string,
    action: "approve" | "pause" | "cancel",
    actorTelegramId: string,
  ): Promise<boolean> {
    return transaction(this.database, async (client) => {
      const result = await client.query(
        action === "approve"
          ? `UPDATE naiskos.release_campaigns SET status='approved',
                approved_at=COALESCE(approved_at,now()), approved_by=$2
              WHERE id=$1 AND status IN ('draft','paused') AND expires_at > now()`
          : action === "pause"
            ? `UPDATE naiskos.release_campaigns SET status='paused'
                WHERE id=$1 AND status='approved'`
            : `UPDATE naiskos.release_campaigns SET status='cancelled'
                WHERE id=$1 AND status IN ('draft','approved','paused')`,
        action === "approve" ? [campaignId, actorTelegramId] : [campaignId],
      );
      if (!result.rowCount) return false;
      await client.query(
        `INSERT INTO naiskos.audit_log (action,details)
         VALUES ($1,$2)`,
        [
          `release.campaign.${action === "approve" ? "approved" : action === "pause" ? "paused" : "cancelled"}`,
          JSON.stringify({ campaignId, actorTelegramId }),
        ],
      );
      return true;
    });
  }

  async expireReleaseCampaigns(
    now = new Date(),
  ): Promise<Array<{ campaignId: string; releaseId: string }>> {
    return transaction(this.database, async (client) => {
      const expired = await client.query<{ id: string; releaseId: string }>(
        `UPDATE naiskos.release_campaigns
            SET status='cancelled'
          WHERE status IN ('draft','approved','paused') AND expires_at <= $1
        RETURNING id, release_id AS "releaseId"`,
        [now],
      );
      for (const campaign of expired.rows) {
        await client.query(
          `INSERT INTO naiskos.audit_log (action,details)
           VALUES ('release.campaign.expired',$1)`,
          [JSON.stringify({
            campaignId: campaign.id,
            releaseId: campaign.releaseId,
            expiredAt: now.toISOString(),
          })],
        );
      }
      return expired.rows.map((campaign) => ({
        campaignId: campaign.id,
        releaseId: campaign.releaseId,
      }));
    });
  }

  async ensureMonthlySystemUpdateCampaign(now = new Date()): Promise<string | null> {
    const schedule = monthlyGeneralSchedule(now);
    if (now < schedule.scheduledAt || now >= schedule.expiresAt) return null;
    return transaction(this.database, async (client) => {
      const frames = await client.query<{ id: string }>(
        "SELECT id FROM naiskos.frames WHERE status='active' ORDER BY id",
      );
      if (!frames.rowCount) return null;
      const campaignId = randomUUID();
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO naiskos.system_update_campaigns
           (id,kind,period,status,scheduled_at,expires_at)
         VALUES ($1,'general',$2,'approved',$3,$4)
         ON CONFLICT (kind,period) DO NOTHING RETURNING id`,
        [campaignId, schedule.period, schedule.scheduledAt, schedule.expiresAt],
      );
      if (!inserted.rowCount) return null;
      const periodSeed = Number(schedule.period.replace("-", ""));
      const uniqueFrames = frames.rows
        .map((frame) => frame.id)
        .sort((left, right) => stableRank(left, periodSeed) - stableRank(right, periodSeed));
      const pilotLimit = Math.max(1, Math.ceil(uniqueFrames.length * 0.01));
      const tenPercentLimit = Math.max(pilotLimit, Math.ceil(uniqueFrames.length * 0.1));
      for (const [index, frameId] of uniqueFrames.entries()) {
        const stage = index < pilotLimit
          ? "pilot"
          : index < tenPercentLimit
            ? "ten-percent"
            : "remainder";
        await client.query(
          `INSERT INTO naiskos.system_update_assignments
             (campaign_id,frame_id,stage,attempt_id) VALUES ($1,$2,$3,$4)`,
          [campaignId, frameId, stage, randomUUID()],
        );
      }
      await this.audit(client, "system.update.campaign.created", null, null, {
        campaignId,
        period: schedule.period,
        frames: uniqueFrames.length,
        scheduledAt: schedule.scheduledAt.toISOString(),
        expiresAt: schedule.expiresAt.toISOString(),
      });
      return campaignId;
    });
  }

  async getSystemUpdatePermit(frameId: string): Promise<SystemUpdatePermit | null> {
    const result = await this.database.query<SystemUpdatePermit>(
      `SELECT c.id AS "campaignId", a.attempt_id AS "attemptId",
              c.kind, c.period, c.timezone,
              to_char(c.maintenance_from, 'HH24:MI') AS "maintenanceFrom",
              to_char(c.maintenance_until, 'HH24:MI') AS "maintenanceUntil",
              c.expires_at AS "expiresAt"
         FROM naiskos.system_update_assignments a
         JOIN naiskos.system_update_campaigns c ON c.id=a.campaign_id
        WHERE a.frame_id=$1 AND c.status='approved' AND c.scheduled_at <= now()
          AND c.expires_at > now() AND a.status IN ('assigned','deferred')
          AND CASE a.stage WHEN 'pilot' THEN 1 WHEN 'ten-percent' THEN 2 ELSE 3 END
              <= CASE c.active_stage WHEN 'pilot' THEN 1 WHEN 'ten-percent' THEN 2 ELSE 3 END
        ORDER BY c.scheduled_at DESC LIMIT 1`,
      [frameId],
    );
    return oneOrNull(result.rows);
  }

  async listSystemUpdateCampaigns(): Promise<SystemUpdateCampaignSummary[]> {
    const result = await this.database.query<SystemUpdateCampaignSummary>(
      `SELECT c.id,c.period,c.status,c.active_stage AS "activeStage",
              c.scheduled_at AS "scheduledAt", c.expires_at AS "expiresAt",
              count(a.frame_id)::integer AS frames,
              count(*) FILTER (WHERE a.status='installed')::integer AS installed,
              count(*) FILTER (WHERE a.status='failed')::integer AS failed
         FROM naiskos.system_update_campaigns c
         LEFT JOIN naiskos.system_update_assignments a ON a.campaign_id=c.id
        GROUP BY c.id ORDER BY c.scheduled_at DESC LIMIT 12`,
    );
    return result.rows;
  }

  async transitionSystemUpdateCampaign(
    campaignId: string,
    action: "resume" | "pause" | "cancel",
    actorTelegramId: string,
  ): Promise<boolean> {
    return transaction(this.database, async (client) => {
      const result = await client.query(
        action === "resume"
          ? "UPDATE naiskos.system_update_campaigns SET status='approved' WHERE id=$1 AND status='paused' AND expires_at>now()"
          : action === "pause"
            ? "UPDATE naiskos.system_update_campaigns SET status='paused' WHERE id=$1 AND status='approved'"
            : "UPDATE naiskos.system_update_campaigns SET status='cancelled' WHERE id=$1 AND status IN ('approved','paused')",
        [campaignId],
      );
      if (!result.rowCount) return false;
      if (action === "resume") {
        await client.query(
          `UPDATE naiskos.system_update_assignments
              SET status='assigned',attempt_id=gen_random_uuid(),last_error=NULL,updated_at=now()
            WHERE campaign_id=$1 AND status='failed'`,
          [campaignId],
        );
      }
      await this.audit(client, `system.update.campaign.${action}`, null, null, {
        campaignId,
        actorTelegramId,
      });
      return true;
    });
  }

  async advanceSystemUpdateCampaigns(): Promise<string[]> {
    return transaction(this.database, async (client) => {
      const changes: string[] = [];
      const expired = await client.query<{ id: string; period: string }>(
        `UPDATE naiskos.system_update_campaigns
            SET status='cancelled'
          WHERE status IN ('approved','paused') AND expires_at <= now()
        RETURNING id,period`,
      );
      for (const campaign of expired.rows) {
        await this.audit(client, "system.update.campaign.expired", null, null, {
          campaignId: campaign.id,
          period: campaign.period,
        });
        changes.push(`expired:${campaign.id}`);
      }
      const campaigns = await client.query<{
        id: string;
        period: string;
        activeStage: "pilot" | "ten-percent" | "remainder";
        observeMinutes: number;
        failureThresholdPercent: number;
      }>(
        `SELECT id,period,active_stage AS "activeStage",
                observe_minutes AS "observeMinutes",
                failure_threshold_percent::float8 AS "failureThresholdPercent"
           FROM naiskos.system_update_campaigns
          WHERE status='approved' FOR UPDATE`,
      );
      for (const campaign of campaigns.rows) {
        const timedOut = await client.query(
          `UPDATE naiskos.system_update_assignments
              SET status='failed',last_error='El intento excedió tres horas sin resultado final',updated_at=now()
            WHERE campaign_id=$1
              AND status IN ('running','reboot_pending','verifying')
              AND updated_at < now()-interval '3 hours'`,
          [campaign.id],
        );
        if (timedOut.rowCount) {
          await client.query(
            "UPDATE naiskos.system_update_campaigns SET status='paused' WHERE id=$1",
            [campaign.id],
          );
          await this.audit(client, "system.update.campaign.attempt-timeout", null, null, {
            campaignId: campaign.id,
            attempts: timedOut.rowCount,
          });
          changes.push(`paused:${campaign.id}:attempt-timeout`);
          continue;
        }
        const state = await client.query<{
          total: number;
          observing: number;
          failed: number;
          unhealthy: number;
          observationReady: boolean;
        }>(
          `SELECT count(*)::integer AS total,
                  count(*) FILTER (WHERE a.status='observing')::integer AS observing,
                  count(*) FILTER (WHERE a.status='failed')::integer AS failed,
                  count(*) FILTER (
                    WHERE a.status <> 'failed' AND (
                       r.last_seen_at IS NULL OR r.last_seen_at < now()-interval '15 minutes'
                       OR r.agent_state NOT IN ('ready','syncing') OR r.last_error IS NOT NULL
                       OR EXISTS (
                         SELECT 1 FROM naiskos.frame_notifications n
                          WHERE n.frame_id=a.frame_id AND n.resolved_at IS NULL
                            AND n.dismissed_at IS NULL AND n.severity='error'
                       )
                    )
                  )::integer AS unhealthy,
                  coalesce(bool_and(
                    a.status IN ('installed','failed') OR
                    (a.status='observing' AND a.updated_at <= now()-make_interval(mins=>$2))
                  ),false) AS "observationReady"
             FROM naiskos.system_update_assignments a
             LEFT JOIN naiskos.frame_runtime r ON r.frame_id=a.frame_id
            WHERE a.campaign_id=$1
              AND CASE a.stage WHEN 'pilot' THEN 1 WHEN 'ten-percent' THEN 2 ELSE 3 END
                  <= CASE $3 WHEN 'pilot' THEN 1 WHEN 'ten-percent' THEN 2 ELSE 3 END`,
          [campaign.id, campaign.observeMinutes, campaign.activeStage],
        );
        const current = state.rows[0];
        if (!current || current.total === 0) continue;
        const failurePercent = (current.failed / current.total) * 100;
        if (current.failed > 0 && failurePercent >= campaign.failureThresholdPercent) {
            await client.query(
              "UPDATE naiskos.system_update_campaigns SET status='paused' WHERE id=$1",
              [campaign.id],
            );
            await this.audit(client, "system.update.campaign.auto-paused", null, null, {
              campaignId: campaign.id,
              period: campaign.period,
              failed: current.failed,
              total: current.total,
              failurePercent,
              threshold: campaign.failureThresholdPercent,
            });
            changes.push(`paused:${campaign.id}`);
          continue;
        }
        if (!current.observationReady || current.unhealthy > 0 || current.observing === 0) continue;
        await client.query(
          `UPDATE naiskos.system_update_assignments SET status='installed',observed_at=now(),updated_at=now()
            WHERE campaign_id=$1 AND status='observing'`,
          [campaign.id],
        );
        const next = await client.query<{ stage: "ten-percent" | "remainder" | null }>(
          `SELECT CASE min(CASE stage WHEN 'pilot' THEN 1 WHEN 'ten-percent' THEN 2 ELSE 3 END)
                    WHEN 2 THEN 'ten-percent' WHEN 3 THEN 'remainder' ELSE NULL END AS stage
             FROM naiskos.system_update_assignments
            WHERE campaign_id=$1
              AND CASE stage WHEN 'pilot' THEN 1 WHEN 'ten-percent' THEN 2 ELSE 3 END
                  > CASE $2 WHEN 'pilot' THEN 1 WHEN 'ten-percent' THEN 2 ELSE 3 END`,
          [campaign.id, campaign.activeStage],
        );
        const nextStage = next.rows[0]?.stage ?? null;
        if (nextStage) {
          await client.query(
            "UPDATE naiskos.system_update_campaigns SET active_stage=$2 WHERE id=$1",
            [campaign.id, nextStage],
          );
          await this.audit(client, "system.update.campaign.stage-advanced", null, null, {
            campaignId: campaign.id,
            from: campaign.activeStage,
            to: nextStage,
          });
          changes.push(`advanced:${campaign.id}:${nextStage}`);
        } else {
          await client.query(
            "UPDATE naiskos.system_update_campaigns SET status='completed',completed_at=now() WHERE id=$1",
            [campaign.id],
          );
          await this.audit(client, "system.update.campaign.completed", null, null, {
            campaignId: campaign.id,
            period: campaign.period,
          });
          changes.push(`completed:${campaign.id}`);
        }
      }
      return changes;
    });
  }

  async automaticallyEnrollDevice(
    input: AutomaticDeviceEnrollmentInput,
  ): Promise<AutomaticDeviceEnrollmentResult> {
    return transaction(this.database, async (client) => {
      const existing = await client.query<{ id: string; name: string }>(
        `SELECT id, name FROM naiskos.frames
          WHERE hardware_fingerprint=$1 AND status <> 'disabled'
          FOR UPDATE`,
        [input.hardwareFingerprint],
      );
      let frame = existing.rows[0];
      const created = !frame;
      if (!frame) {
        frame = { id: randomUUID(), name: input.suggestedName };
        await client.query(
          `INSERT INTO naiskos.frames
             (id, name, status, width, height, hardware_fingerprint)
           VALUES ($1,$2,'active',$3,$4,$5)`,
          [
            frame.id,
            frame.name,
            input.width,
            input.height,
            input.hardwareFingerprint,
          ],
        );
      }

      const tokenOwner = await client.query<{ frameId: string }>(
        `SELECT frame_id AS "frameId" FROM naiskos.agent_tokens
          WHERE token_hash=$1 AND revoked_at IS NULL`,
        [input.tokenHash],
      );
      if (tokenOwner.rows[0] && tokenOwner.rows[0].frameId !== frame.id) {
        throw new Error("La credencial del agente pertenece a otro marco");
      }
      if (!tokenOwner.rows[0]) {
        await client.query(
          `INSERT INTO naiskos.agent_tokens (id, frame_id, token_hash, label)
           VALUES ($1,$2,$3,$4)`,
          [
            randomUUID(),
            frame.id,
            input.tokenHash,
            created ? "automatic-first-boot" : "automatic-recovery",
          ],
        );
      }
      await client.query(
        `INSERT INTO naiskos.frame_pairing_codes (frame_id, code_hash)
         VALUES ($1,$2)
         ON CONFLICT (frame_id) DO UPDATE SET
           code_hash=EXCLUDED.code_hash, rotated_at=now()
         WHERE naiskos.frame_pairing_codes.code_hash IS DISTINCT FROM EXCLUDED.code_hash`,
        [frame.id, input.pairingCodeHash],
      );
      await client.query(
        `UPDATE naiskos.device_enrollments
            SET status='approved', frame_id=$2, resolved_at=now(),
                resolved_by_telegram_id='automatic-first-boot'
          WHERE hardware_fingerprint=$1 AND status='pending'`,
        [input.hardwareFingerprint, frame.id],
      );
      await this.audit(
        client,
        created ? "device.auto-enrolled" : "device.auto-recovered",
        frame.id,
        null,
        { deviceModel: input.deviceModel },
      );
      return { frameId: frame.id, frameName: frame.name, created };
    });
  }

  async setFramePairingCode(frameId: string, codeHash: Buffer): Promise<void> {
    await transaction(this.database, async (client) => {
      const changed = await client.query(
        `INSERT INTO naiskos.frame_pairing_codes (frame_id, code_hash)
         VALUES ($1,$2)
         ON CONFLICT (frame_id) DO UPDATE SET
           code_hash=EXCLUDED.code_hash, rotated_at=now()
         WHERE naiskos.frame_pairing_codes.code_hash IS DISTINCT FROM EXCLUDED.code_hash`,
        [frameId, codeHash],
      );
      if (changed.rowCount) {
        await this.audit(client, "frame.pairing-code.rotated", frameId, null, {});
      }
    });
  }

  async linkFrameByPairingCode(
    code: string,
    telegramUserId: string,
  ): Promise<InvitationResult | null> {
    return transaction(this.database, async (client) => {
      const result = await client.query<{ frameId: string; frameName: string }>(
        `SELECT p.frame_id AS "frameId", f.name AS "frameName"
           FROM naiskos.frame_pairing_codes p
           JOIN naiskos.frames f ON f.id=p.frame_id
          WHERE p.code_hash=$1 AND f.status='active'
          FOR UPDATE OF p`,
        [tokenHash(code)],
      );
      const frame = oneOrNull(result.rows);
      if (!frame) return null;
      await client.query(
        `INSERT INTO naiskos.frame_memberships
           (frame_id, telegram_user_id, status)
         VALUES ($1,$2,'approved')
         ON CONFLICT (frame_id, telegram_user_id) DO UPDATE SET
           status='approved', updated_at=now()`,
        [frame.frameId, telegramUserId],
      );
      await this.audit(
        client,
        "frame.pairing.linked",
        frame.frameId,
        telegramUserId,
        {},
      );
      return frame;
    });
  }

  async claimFrameByPairingCode(
    code: string,
    telegramUserId: string,
  ): Promise<InvitationResult | null> {
    return transaction(this.database, async (client) => {
      const result = await client.query<{ frameId: string; frameName: string }>(
        `SELECT p.frame_id AS "frameId", f.name AS "frameName"
           FROM naiskos.frame_pairing_codes p
           JOIN naiskos.frames f ON f.id=p.frame_id
          WHERE p.code_hash=$1 AND f.status='active'`,
        [tokenHash(code)],
      );
      const frame = oneOrNull(result.rows);
      if (!frame) return null;
      await client.query(
        `INSERT INTO naiskos.frame_pairing_claims
           (frame_id, telegram_user_id)
         VALUES ($1,$2)
         ON CONFLICT (frame_id, telegram_user_id) DO UPDATE SET
           created_at=now(), expires_at=now() + interval '24 hours'`,
        [frame.frameId, telegramUserId],
      );
      await this.audit(
        client,
        "frame.pairing.claimed",
        frame.frameId,
        telegramUserId,
        {},
      );
      return frame;
    });
  }

  async createDeviceEnrollment(
    input: DeviceEnrollmentInput,
  ): Promise<DeviceEnrollmentMutationResult> {
    return transaction(this.database, async (client) => {
      await expireDeviceEnrollments(client);
      const enrolled = await client.query<{ id: string; name: string }>(
        `SELECT id, name FROM naiskos.frames
          WHERE hardware_fingerprint=$1 AND status <> 'disabled'`,
        [input.hardwareFingerprint],
      );
      if (enrolled.rows[0]) {
        return {
          changed: false,
          status: "already_enrolled",
          frameId: enrolled.rows[0].id,
          frameName: enrolled.rows[0].name,
        };
      }
      const existing = await client.query<{
        hardwareFingerprint: Buffer;
        tokenHash: Buffer;
        claimCodeHash: Buffer;
        status: DeviceEnrollmentSummary["status"];
      }>(
        `SELECT hardware_fingerprint AS "hardwareFingerprint",
                token_hash AS "tokenHash", claim_code_hash AS "claimCodeHash", status
           FROM naiskos.device_enrollments WHERE id=$1`,
        [input.requestId],
      );
      if (existing.rows[0]) {
        const same =
          existing.rows[0].hardwareFingerprint.equals(input.hardwareFingerprint) &&
          existing.rows[0].tokenHash.equals(input.tokenHash) &&
          existing.rows[0].claimCodeHash.equals(input.claimCodeHash);
        return {
          changed: false,
          status: same ? existing.rows[0].status : "missing",
        };
      }
      const pending = await client.query(
        `SELECT 1 FROM naiskos.device_enrollments
          WHERE hardware_fingerprint=$1 AND status='pending'`,
        [input.hardwareFingerprint],
      );
      if (pending.rowCount) return { changed: false, status: "missing" };
      await client.query(
        `INSERT INTO naiskos.device_enrollments
           (id, hardware_fingerprint, token_hash, claim_code_hash,
            device_model, suggested_name, width, height)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          input.requestId,
          input.hardwareFingerprint,
          input.tokenHash,
          input.claimCodeHash,
          input.deviceModel,
          input.suggestedName,
          input.width,
          input.height,
        ],
      );
      await this.audit(client, "device.enrollment.created", null, null, {
        requestId: input.requestId,
        deviceModel: input.deviceModel,
      });
      return { changed: true, status: "pending" };
    });
  }

  async getDeviceEnrollment(
    requestId: string,
    agentToken: string,
  ): Promise<DeviceEnrollmentSummary | null> {
    return transaction(this.database, async (client) => {
      await expireDeviceEnrollments(client);
      const result = await client.query<{
        requestId: string;
        status: DeviceEnrollmentSummary["status"];
        deviceModel: string;
        suggestedName: string;
        width: number;
        height: number;
        expiresAt: Date;
        frameId: string | null;
        frameName: string | null;
      }>(
        `SELECT e.id AS "requestId", e.status, e.device_model AS "deviceModel",
                e.suggested_name AS "suggestedName", e.width, e.height,
                e.expires_at AS "expiresAt", e.frame_id AS "frameId",
                f.name AS "frameName"
           FROM naiskos.device_enrollments e
           LEFT JOIN naiskos.frames f ON f.id=e.frame_id
          WHERE e.id=$1 AND e.token_hash=$2`,
        [requestId, tokenHash(agentToken)],
      );
      const row = result.rows[0];
      return row ? { ...row, expiresAt: row.expiresAt.toISOString() } : null;
    });
  }

  async findDeviceEnrollmentByClaimCode(
    code: string,
  ): Promise<DeviceEnrollmentSummary | null> {
    return transaction(this.database, async (client) => {
      await expireDeviceEnrollments(client);
      const result = await client.query<{
        requestId: string;
        status: DeviceEnrollmentSummary["status"];
        deviceModel: string;
        suggestedName: string;
        width: number;
        height: number;
        expiresAt: Date;
        frameId: string | null;
        frameName: string | null;
      }>(
        `SELECT e.id AS "requestId", e.status, e.device_model AS "deviceModel",
                e.suggested_name AS "suggestedName", e.width, e.height,
                e.expires_at AS "expiresAt", e.frame_id AS "frameId",
                f.name AS "frameName"
           FROM naiskos.device_enrollments e
           LEFT JOIN naiskos.frames f ON f.id=e.frame_id
          WHERE e.claim_code_hash=$1`,
        [tokenHash(code)],
      );
      const row = result.rows[0];
      return row ? { ...row, expiresAt: row.expiresAt.toISOString() } : null;
    });
  }

  async approveDeviceEnrollment(
    requestId: string,
    actorTelegramId: string,
  ): Promise<DeviceEnrollmentMutationResult> {
    return transaction(this.database, async (client) => {
      await expireDeviceEnrollments(client);
      const enrollment = await client.query<{
        hardwareFingerprint: Buffer;
        tokenHash: Buffer;
        suggestedName: string;
        width: number;
        height: number;
      }>(
        `SELECT hardware_fingerprint AS "hardwareFingerprint",
                token_hash AS "tokenHash", suggested_name AS "suggestedName",
                width, height
           FROM naiskos.device_enrollments
          WHERE id=$1 AND status='pending' FOR UPDATE`,
        [requestId],
      );
      const row = enrollment.rows[0];
      if (!row) return { changed: false, status: "missing" };
      const already = await client.query<{ id: string; name: string }>(
        "SELECT id, name FROM naiskos.frames WHERE hardware_fingerprint=$1",
        [row.hardwareFingerprint],
      );
      if (already.rows[0]) {
        return {
          changed: false,
          status: "already_enrolled",
          frameId: already.rows[0].id,
          frameName: already.rows[0].name,
        };
      }
      const frameId = randomUUID();
      const tokenId = randomUUID();
      await client.query(
        `INSERT INTO naiskos.frames
           (id, name, status, width, height, hardware_fingerprint)
         VALUES ($1,$2,'active',$3,$4,$5)`,
        [frameId, row.suggestedName, row.width, row.height, row.hardwareFingerprint],
      );
      await client.query(
        `INSERT INTO naiskos.agent_tokens (id, frame_id, token_hash, label)
         VALUES ($1,$2,$3,'device-enrollment')`,
        [tokenId, frameId, row.tokenHash],
      );
      await client.query(
        `UPDATE naiskos.device_enrollments
            SET status='approved', frame_id=$2, resolved_at=now(),
                resolved_by_telegram_id=$3
          WHERE id=$1`,
        [requestId, frameId, actorTelegramId],
      );
      await this.audit(client, "device.enrollment.approved", frameId, null, {
        requestId,
        actorTelegramId,
        tokenId,
      });
      return {
        changed: true,
        status: "approved",
        frameId,
        frameName: row.suggestedName,
      };
    });
  }

  async rejectDeviceEnrollment(
    requestId: string,
    actorTelegramId: string,
  ): Promise<DeviceEnrollmentMutationResult> {
    return transaction(this.database, async (client) => {
      await expireDeviceEnrollments(client);
      const result = await client.query(
        `UPDATE naiskos.device_enrollments
            SET status='rejected', resolved_at=now(), resolved_by_telegram_id=$2
          WHERE id=$1 AND status='pending'`,
        [requestId, actorTelegramId],
      );
      if (!result.rowCount) return { changed: false, status: "missing" };
      await this.audit(client, "device.enrollment.rejected", null, null, {
        requestId,
        actorTelegramId,
      });
      return { changed: true, status: "rejected" };
    });
  }

  async findTelegramUser(telegramId: string): Promise<TelegramUser | null> {
    const result = await this.database.query<TelegramUser>(
      `SELECT id, telegram_id AS "telegramId", status
         FROM naiskos.telegram_users WHERE telegram_id = $1`,
      [telegramId],
    );
    return oneOrNull(result.rows);
  }

  async claimTelegramUpdate(updateId: number): Promise<boolean> {
    const result = await this.database.query(
      `INSERT INTO naiskos.telegram_updates (update_id) VALUES ($1)
       ON CONFLICT (update_id) DO NOTHING`,
      [updateId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async completeTelegramUpdate(updateId: number): Promise<void> {
    await this.database.query(
      "UPDATE naiskos.telegram_updates SET processed_at=now() WHERE update_id=$1",
      [updateId],
    );
  }

  async releaseTelegramUpdate(updateId: number): Promise<void> {
    await this.database.query(
      "DELETE FROM naiskos.telegram_updates WHERE update_id=$1 AND processed_at IS NULL",
      [updateId],
    );
  }

  async upsertPendingTelegramUser(
    telegramId: string,
    displayName: string,
  ): Promise<TelegramUser> {
    const result = await this.database.query<TelegramUser>(
      `INSERT INTO naiskos.telegram_users (telegram_id, display_name, status)
       VALUES ($1, $2, 'pending')
       ON CONFLICT (telegram_id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         status = CASE
           WHEN naiskos.telegram_users.status='rejected' THEN 'pending'
           ELSE naiskos.telegram_users.status
         END,
         updated_at = now()
       RETURNING id, telegram_id AS "telegramId", status`,
      [telegramId, displayName],
    );
    return result.rows[0]!;
  }

  async approveTelegramUser(
    telegramId: string,
    actorTelegramId: string,
  ): Promise<TelegramApprovalResult> {
    return transaction(this.database, async (client) => {
      const result = await client.query<{ id: string }>(
        `UPDATE naiskos.telegram_users SET status = 'approved', approved_at = now(), updated_at = now()
          WHERE telegram_id = $1 AND status = 'pending'
          RETURNING id`,
        [telegramId],
      );
      const user = result.rows[0];
      if (!user) return { approved: false, grantedFrames: [] };
      const actor = await client.query<{ id: string }>(
        "SELECT id FROM naiskos.telegram_users WHERE telegram_id=$1",
        [actorTelegramId],
      );
      await this.audit(
        client,
        "telegram.user.approved",
        null,
        actor.rows[0]?.id ?? null,
        { telegramId, actorTelegramId },
      );

      const claims = await client.query<{
        id: string;
        frameId: string;
        frameName: string;
      }>(
        `SELECT i.id, i.frame_id AS "frameId", f.name AS "frameName"
           FROM naiskos.frame_invitations i
           JOIN naiskos.frames f ON f.id=i.frame_id
          WHERE i.claimed_by_telegram_user_id=$1
            AND i.used_at IS NULL AND i.expires_at > now()
          ORDER BY i.created_at
          FOR UPDATE OF i`,
        [user.id],
      );
      const grantedFrames: InvitationResult[] = [];
      for (const invitation of claims.rows) {
        await client.query(
          `INSERT INTO naiskos.frame_memberships
             (frame_id, telegram_user_id, status)
           VALUES ($1, $2, 'approved')
           ON CONFLICT (frame_id, telegram_user_id) DO UPDATE
             SET status='approved', updated_at=now()`,
          [invitation.frameId, user.id],
        );
        await client.query(
          "UPDATE naiskos.frame_invitations SET used_at=now() WHERE id=$1",
          [invitation.id],
        );
        await this.audit(
          client,
          "frame.invitation.consumed",
          invitation.frameId,
          user.id,
          { invitationId: invitation.id, consumedDuringGlobalApproval: true },
        );
        grantedFrames.push({
          frameId: invitation.frameId,
          frameName: invitation.frameName,
        });
      }
      const pairingClaims = await client.query<{
        frameId: string;
        frameName: string;
      }>(
        `SELECT c.frame_id AS "frameId", f.name AS "frameName"
           FROM naiskos.frame_pairing_claims c
           JOIN naiskos.frames f ON f.id=c.frame_id
          WHERE c.telegram_user_id=$1 AND c.expires_at > now()
          ORDER BY c.created_at
          FOR UPDATE OF c`,
        [user.id],
      );
      for (const claim of pairingClaims.rows) {
        await client.query(
          `INSERT INTO naiskos.frame_memberships
             (frame_id, telegram_user_id, status)
           VALUES ($1,$2,'approved')
           ON CONFLICT (frame_id, telegram_user_id) DO UPDATE SET
             status='approved', updated_at=now()`,
          [claim.frameId, user.id],
        );
        await this.audit(
          client,
          "frame.pairing.linked",
          claim.frameId,
          user.id,
          { linkedDuringGlobalApproval: true },
        );
        if (!grantedFrames.some((frame) => frame.frameId === claim.frameId)) {
          grantedFrames.push(claim);
        }
      }
      await client.query(
        "DELETE FROM naiskos.frame_pairing_claims WHERE telegram_user_id=$1",
        [user.id],
      );
      return { approved: true, grantedFrames };
    });
  }

  rejectTelegramUser(
    telegramId: string,
    actorTelegramId: string,
  ): Promise<boolean> {
    return this.transitionTelegramUser(
      telegramId,
      actorTelegramId,
      ["pending"],
      "rejected",
      "telegram.user.rejected",
      false,
    );
  }

  blockTelegramUser(
    telegramId: string,
    actorTelegramId: string,
  ): Promise<boolean> {
    return this.transitionTelegramUser(
      telegramId,
      actorTelegramId,
      ["pending", "approved", "rejected", "revoked"],
      "blocked",
      "telegram.user.blocked",
      true,
    );
  }

  unblockTelegramUser(
    telegramId: string,
    actorTelegramId: string,
  ): Promise<boolean> {
    return this.transitionTelegramUser(
      telegramId,
      actorTelegramId,
      ["blocked"],
      "pending",
      "telegram.user.unblocked",
      false,
    );
  }

  revokeTelegramUser(
    telegramId: string,
    actorTelegramId: string,
  ): Promise<boolean> {
    return this.transitionTelegramUser(
      telegramId,
      actorTelegramId,
      ["approved"],
      "revoked",
      "telegram.user.revoked",
      true,
    );
  }

  reactivateTelegramUser(
    telegramId: string,
    actorTelegramId: string,
  ): Promise<boolean> {
    return this.transitionTelegramUser(
      telegramId,
      actorTelegramId,
      ["revoked"],
      "pending",
      "telegram.user.reactivated",
      false,
    );
  }

  async claimInvitation(
    code: string,
    telegramUserId: string,
  ): Promise<InvitationResult | null> {
    return transaction(this.database, async (client) => {
      const result = await client.query<{
        id: string;
        frameId: string;
        frameName: string;
        claimedByTelegramUserId: string | null;
      }>(
        `SELECT i.id, i.frame_id AS "frameId", f.name AS "frameName",
                i.claimed_by_telegram_user_id AS "claimedByTelegramUserId"
           FROM naiskos.frame_invitations i
           JOIN naiskos.frames f ON f.id=i.frame_id
          WHERE i.code_hash=$1 AND i.used_at IS NULL AND i.expires_at > now()
            AND (i.claimed_by_telegram_user_id IS NULL
                 OR i.claimed_by_telegram_user_id=$2)
          FOR UPDATE OF i`,
        [tokenHash(code), telegramUserId],
      );
      const invitation = oneOrNull(result.rows);
      if (!invitation) return null;
      if (!invitation.claimedByTelegramUserId) {
        await client.query(
          `UPDATE naiskos.frame_invitations
              SET claimed_by_telegram_user_id=$2, claimed_at=now()
            WHERE id=$1`,
          [invitation.id, telegramUserId],
        );
        await this.audit(
          client,
          "frame.invitation.claimed",
          invitation.frameId,
          telegramUserId,
          { invitationId: invitation.id },
        );
      }
      return {
        frameId: invitation.frameId,
        frameName: invitation.frameName,
      };
    });
  }

  async consumeInvitation(
    code: string,
    telegramUserId: string,
  ): Promise<InvitationResult | null> {
    return transaction(this.database, async (client) => {
      const result = await client.query<{
        id: string;
        frameId: string;
        frameName: string;
      }>(
        `SELECT i.id, i.frame_id AS "frameId", f.name AS "frameName"
           FROM naiskos.frame_invitations i
           JOIN naiskos.frames f ON f.id = i.frame_id
          WHERE i.code_hash = $1 AND i.used_at IS NULL AND i.expires_at > now()
            AND (i.claimed_by_telegram_user_id IS NULL
                 OR i.claimed_by_telegram_user_id=$2)
          FOR UPDATE OF i`,
        [tokenHash(code), telegramUserId],
      );
      const invitation = oneOrNull(result.rows);
      if (!invitation) return null;
      await client.query(
        `INSERT INTO naiskos.frame_memberships (frame_id, telegram_user_id, status)
         VALUES ($1, $2, 'approved')
         ON CONFLICT (frame_id, telegram_user_id) DO UPDATE SET status = 'approved', updated_at = now()`,
        [invitation.frameId, telegramUserId],
      );
      await client.query(
        `UPDATE naiskos.frame_invitations
            SET claimed_by_telegram_user_id=COALESCE(claimed_by_telegram_user_id, $2),
                claimed_at=COALESCE(claimed_at, now()), used_at=now()
          WHERE id=$1`,
        [invitation.id, telegramUserId],
      );
      await this.audit(
        client,
        "frame.invitation.consumed",
        invitation.frameId,
        telegramUserId,
        {},
      );
      return { frameId: invitation.frameId, frameName: invitation.frameName };
    });
  }

  async accessibleFrames(
    telegramUserId: string,
  ): Promise<Array<{ id: string; name: string }>> {
    const result = await this.database.query<{ id: string; name: string }>(
      `SELECT f.id, f.name
         FROM naiskos.frame_memberships m JOIN naiskos.frames f ON f.id = m.frame_id
        WHERE m.telegram_user_id = $1 AND m.status = 'approved' AND f.status = 'active'
        ORDER BY f.name`,
      [telegramUserId],
    );
    return result.rows;
  }

  async createPendingSelection(
    telegramUserId: string,
    payload: IngestJobPayload,
    frameIds: string[],
  ): Promise<string> {
    const code = randomBytes(7).toString("base64url");
    await this.database.query(
      `INSERT INTO naiskos.pending_selections
         (code, telegram_user_id, payload, allowed_frame_ids)
       VALUES ($1,$2,$3,$4)`,
      [code, telegramUserId, JSON.stringify(payload), frameIds],
    );
    return code;
  }

  async updatePendingSelection(
    code: string,
    telegramUserId: string,
    operation: "all" | "toggle" | "done",
    index?: number,
  ): Promise<{
    state: "updated" | "completed" | "missing" | "empty";
    payload?: IngestJobPayload;
    count?: number;
  }> {
    return transaction(this.database, async (client) => {
      const result = await client.query<PendingSelection>(
        `SELECT code, payload, allowed_frame_ids AS "allowedFrameIds", selected_frame_ids AS "selectedFrameIds"
           FROM naiskos.pending_selections
          WHERE code=$1 AND telegram_user_id=$2 AND consumed_at IS NULL AND expires_at > now()
          FOR UPDATE`,
        [code, telegramUserId],
      );
      const selection = result.rows[0];
      if (!selection) return { state: "missing" };
      let selected = selection.selectedFrameIds;
      if (operation === "all") selected = [...selection.allowedFrameIds];
      if (operation === "toggle") {
        const frameId = selection.allowedFrameIds[index ?? -1];
        if (!frameId) return { state: "missing" };
        selected = selected.includes(frameId)
          ? selected.filter((id) => id !== frameId)
          : [...selected, frameId];
      }
      if (operation !== "done") {
        await client.query(
          "UPDATE naiskos.pending_selections SET selected_frame_ids=$2 WHERE code=$1",
          [code, selected],
        );
        return { state: "updated", count: selected.length };
      }
      if (selected.length === 0) return { state: "empty" };
      await client.query(
        "UPDATE naiskos.pending_selections SET consumed_at=now() WHERE code=$1",
        [code],
      );
      return {
        state: "completed",
        payload: { ...selection.payload, frameIds: selected },
        count: selected.length,
      };
    });
  }

  async enqueueIngest(payload: IngestJobPayload): Promise<string> {
    const id = randomUUID();
    await transaction(this.database, async (client) => {
      await client.query(
        `INSERT INTO naiskos.jobs (id, kind, payload, status, available_at)
         VALUES ($1, 'telegram.ingest', $2, 'pending', now())`,
        [id, JSON.stringify(payload)],
      );
      await queueTelegramMediaNotice(
        client,
        payload.chatId,
        "media.received",
      );
      for (const frameId of payload.frameIds) {
        await this.audit(
          client,
          "media.received",
          frameId,
          payload.telegramUserId,
          {
            jobId: id,
            telegramFileUniqueId: payload.telegramFileUniqueId,
            kind: payload.kind,
          },
        );
      }
    });
    return id;
  }

  async getManifest(
    frameId: string,
    publicUrl: string,
  ): Promise<Record<string, unknown>> {
    const frameResult = await this.database.query<{
      id: string;
      manifestVersion: string;
      settingsRevision: string;
      settings: Record<string, unknown>;
    }>(
      `SELECT id, manifest_version::text AS "manifestVersion",
              settings_revision::text AS "settingsRevision", settings
         FROM naiskos.frames WHERE id = $1`,
      [frameId],
    );
    const frame = frameResult.rows[0]!;
    const mediaResult = await this.database.query<Record<string, unknown>>(
      `SELECT m.id, m.kind, v.id AS "variantId", v.extension, m.caption,
              u.display_name AS "senderName",
              m.created_at AS "receivedAt", fm.fit_mode AS "fitMode",
              fm.rotation_degrees AS "rotationDegrees",
              v.duration_seconds::double precision AS "durationSeconds",
              encode(v.sha256, 'hex') AS sha256,
              v.size_bytes::double precision AS "sizeBytes", pv.id AS "posterVariantId",
              pv.extension AS "posterExtension", encode(pv.sha256, 'hex') AS "posterSha256",
              pv.size_bytes::double precision AS "posterSizeBytes",
              tv.id AS "thumbnailVariantId", tv.extension AS "thumbnailExtension",
              encode(tv.sha256, 'hex') AS "thumbnailSha256",
              tv.size_bytes::double precision AS "thumbnailSizeBytes"
         FROM naiskos.frame_media fm
         JOIN naiskos.media m ON m.id = fm.media_id
         JOIN naiskos.media_variants v ON v.id = fm.variant_id
         LEFT JOIN naiskos.media_variants pv ON pv.id = fm.poster_variant_id
         LEFT JOIN naiskos.media_variants tv ON tv.id = fm.thumbnail_variant_id
         LEFT JOIN naiskos.telegram_users u ON u.id = m.sender_telegram_user_id
        WHERE fm.frame_id = $1 AND fm.deleted_at IS NULL
          AND fm.sync_status = 'active' AND m.status = 'ready'
        ORDER BY fm.position ASC, m.created_at DESC`,
      [frameId],
    );
    const orderedMedia = orderManifestMedia(
      mediaResult.rows,
      String(frame.settings.order ?? "newest"),
      Number(frame.manifestVersion),
    );
    return {
      schemaVersion: 1,
      frameId,
      version: Number(frame.manifestVersion),
      publishedAt: new Date().toISOString(),
      settingsRevision: Number(frame.settingsRevision),
      settings: frame.settings,
      media: orderedMedia.map((row) => ({
        ...row,
        downloadUrl: `${publicUrl}/api/v1/files/${row.variantId as string}`,
        posterDownloadUrl: row.posterVariantId
          ? `${publicUrl}/api/v1/files/${row.posterVariantId as string}`
          : null,
        thumbnailDownloadUrl: row.thumbnailVariantId
          ? `${publicUrl}/api/v1/files/${row.thumbnailVariantId as string}`
          : null,
      })),
    };
  }

  async saveAutomaticLocation(
    frameId: string,
    location: AutomaticLocation,
    source: "google_wifi" | "maxmind",
  ): Promise<void> {
    await transaction(this.database, async (client) => {
      const current = await client.query<{
        mode: "automatic" | "manual";
        source: "google_wifi" | "maxmind" | "manual" | "telegram";
        latitude: number;
        longitude: number;
        candidate: AutomaticLocation | null;
        candidateObservations: number;
        candidateFirstSeen: Date | null;
      }>(
        `SELECT mode, source, latitude, longitude, candidate,
                candidate_observations AS "candidateObservations",
                candidate_first_seen AS "candidateFirstSeen"
           FROM naiskos.frame_locations WHERE frame_id=$1 FOR UPDATE`,
        [frameId],
      );
      const existing = current.rows[0];
      if (existing?.mode === "manual") return;
      if (!existing) {
        await client.query(
          `INSERT INTO naiskos.frame_locations
           (frame_id, mode, source, label, city, subdivision, country_code,
            latitude, longitude, timezone, accuracy_radius_km)
           VALUES ($1,'automatic',$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          locationValues(frameId, location, source),
        );
        await this.audit(client, "frame.location.detected", frameId, null, {
          source,
          label: location.label,
          accuracyRadiusKm: location.accuracyRadiusKm,
        });
        return;
      }
      if (sameAutomaticLocation(existing, location)) {
        await client.query(
          `UPDATE naiskos.frame_locations
              SET source=$2, label=$3, city=$4, subdivision=$5,
                  country_code=$6, latitude=$7, longitude=$8,
                  timezone=$9, accuracy_radius_km=$10,
                  detected_at=now(), candidate=NULL,
                  candidate_observations=0, candidate_first_seen=NULL,
                  updated_at=now()
            WHERE frame_id=$1`,
          locationValues(frameId, location, source),
        );
        return;
      }

      if (source === "google_wifi") {
        await client.query(
          `UPDATE naiskos.frame_locations SET
             source=$2, label=$3, city=$4, subdivision=$5,
             country_code=$6, latitude=$7, longitude=$8, timezone=$9,
             accuracy_radius_km=$10, candidate=NULL,
             candidate_observations=0, candidate_first_seen=NULL,
             detected_at=now(), updated_at=now()
           WHERE frame_id=$1 AND mode='automatic'`,
          locationValues(frameId, location, source),
        );
        await client.query("DELETE FROM naiskos.frame_weather WHERE frame_id=$1", [
          frameId,
        ]);
        await this.audit(client, "frame.location.changed", frameId, null, {
          source,
          label: location.label,
          accuracyRadiusKm: location.accuracyRadiusKm,
        });
        return;
      }

      const candidateMatches =
        existing.candidate && sameAutomaticLocation(existing.candidate, location);
      const observations = candidateMatches
        ? Number(existing.candidateObservations) + 1
        : 1;
      const firstSeen = candidateMatches
        ? existing.candidateFirstSeen ?? new Date()
        : new Date();
      const stableForMs = Date.now() - firstSeen.getTime();
      if (observations >= 3 && stableForMs >= 30 * 60_000) {
        await client.query(
          `UPDATE naiskos.frame_locations SET
             source=$2, label=$3, city=$4, subdivision=$5,
             country_code=$6, latitude=$7, longitude=$8, timezone=$9,
             accuracy_radius_km=$10, candidate=NULL,
             candidate_observations=0, candidate_first_seen=NULL,
             detected_at=now(), updated_at=now()
           WHERE frame_id=$1 AND mode='automatic'`,
          locationValues(frameId, location, source),
        );
        await client.query("DELETE FROM naiskos.frame_weather WHERE frame_id=$1", [
          frameId,
        ]);
        await this.audit(client, "frame.location.changed", frameId, null, {
          source,
          label: location.label,
          accuracyRadiusKm: location.accuracyRadiusKm,
        });
        return;
      }
      await client.query(
        `UPDATE naiskos.frame_locations
            SET candidate=$2, candidate_observations=$3,
                candidate_first_seen=$4, detected_at=now(), updated_at=now()
          WHERE frame_id=$1 AND mode='automatic'`,
        [frameId, JSON.stringify(location), observations, firstSeen],
      );
    });
  }

  async getFrameWeather(frameId: string): Promise<FrameWeatherRecord | null> {
    const result = await this.database.query<{
      label: string | null;
      city: string | null;
      subdivision: string | null;
      countryCode: string | null;
      latitude: number | null;
      longitude: number | null;
      timezone: string | null;
      source: "google_wifi" | "maxmind" | "manual" | "telegram" | null;
      accuracyRadiusKm: number | null;
      temperatureC: number | null;
      apparentTemperatureC: number | null;
      weatherCode: number | null;
      isDay: boolean | null;
      observedAt: Date | null;
      fetchedAt: Date | null;
      lastError: string | null;
    }>(
      `SELECT l.label, l.city, l.subdivision,
              l.country_code AS "countryCode", l.latitude, l.longitude,
              l.timezone, l.source,
              l.accuracy_radius_km AS "accuracyRadiusKm",
              w.temperature_c AS "temperatureC",
              w.apparent_temperature_c AS "apparentTemperatureC",
              w.weather_code AS "weatherCode", w.is_day AS "isDay",
              w.observed_at AS "observedAt", w.fetched_at AS "fetchedAt",
              w.last_error AS "lastError"
         FROM naiskos.frames f
         LEFT JOIN naiskos.frame_locations l ON l.frame_id=f.id
         LEFT JOIN naiskos.frame_weather w ON w.frame_id=f.id
        WHERE f.id=$1`,
      [frameId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const location =
      row.label &&
      row.countryCode &&
      row.latitude !== null &&
      row.longitude !== null &&
      row.timezone &&
      row.source
        ? {
            label: row.label,
            city: row.city,
            subdivision: row.subdivision,
            countryCode: row.countryCode,
            latitude: Number(row.latitude),
            longitude: Number(row.longitude),
            timezone: row.timezone,
            source: row.source,
            accuracyRadiusKm:
              row.accuracyRadiusKm === null ? null : Number(row.accuracyRadiusKm),
          }
        : null;
    const weather =
      row.temperatureC !== null &&
      row.apparentTemperatureC !== null &&
      row.weatherCode !== null &&
      row.isDay !== null &&
      row.observedAt &&
      row.fetchedAt
        ? {
            temperatureC: Number(row.temperatureC),
            apparentTemperatureC: Number(row.apparentTemperatureC),
            weatherCode: Number(row.weatherCode),
            isDay: row.isDay,
            observedAt: row.observedAt.toISOString(),
            fetchedAt: row.fetchedAt.toISOString(),
          }
        : null;
    return { location, weather, lastError: row.lastError };
  }

  async expireGoogleLocation(frameId: string): Promise<void> {
    await transaction(this.database, async (client) => {
      const expired = await client.query(
        `SELECT 1 FROM naiskos.frame_locations
          WHERE frame_id=$1 AND source='google_wifi'
            AND detected_at <= now() - interval '30 days'
          FOR UPDATE`,
        [frameId],
      );
      if (expired.rowCount === 0) return;
      await client.query("DELETE FROM naiskos.frame_weather WHERE frame_id=$1", [
        frameId,
      ]);
      await client.query("DELETE FROM naiskos.frame_locations WHERE frame_id=$1", [
        frameId,
      ]);
      await this.audit(client, "frame.location.expired", frameId, null, {
        source: "google_wifi",
        retentionDays: 30,
      });
    });
  }

  async recordWeatherSuccess(
    frameId: string,
    weather: {
      temperatureC: number;
      apparentTemperatureC: number;
      weatherCode: number;
      isDay: boolean;
      observedAt: string;
      fetchedAt: string;
    },
  ): Promise<void> {
    await this.database.query(
      `INSERT INTO naiskos.frame_weather
         (frame_id, provider, temperature_c, apparent_temperature_c,
          weather_code, is_day, observed_at, fetched_at, last_attempt_at,
          last_error, updated_at)
       VALUES ($1,'open-meteo',$2,$3,$4,$5,$6,$7,now(),NULL,now())
       ON CONFLICT (frame_id) DO UPDATE SET
         provider='open-meteo', temperature_c=EXCLUDED.temperature_c,
         apparent_temperature_c=EXCLUDED.apparent_temperature_c,
         weather_code=EXCLUDED.weather_code, is_day=EXCLUDED.is_day,
         observed_at=EXCLUDED.observed_at, fetched_at=EXCLUDED.fetched_at,
         last_attempt_at=now(), last_error=NULL, updated_at=now()`,
      [
        frameId,
        weather.temperatureC,
        weather.apparentTemperatureC,
        weather.weatherCode,
        weather.isDay,
        weather.observedAt,
        weather.fetchedAt,
      ],
    );
  }

  async recordWeatherFailure(frameId: string, detail: string): Promise<void> {
    await this.database.query(
      `INSERT INTO naiskos.frame_weather
         (frame_id, provider, last_attempt_at, last_error, updated_at)
       VALUES ($1,'open-meteo',now(),$2,now())
       ON CONFLICT (frame_id) DO UPDATE SET
         last_attempt_at=now(), last_error=EXCLUDED.last_error, updated_at=now()`,
      [frameId, detail.slice(0, 1_000)],
    );
  }

  async variantForFrame(
    frameId: string,
    variantId: string,
  ): Promise<{ storagePath: string; mimeType: string } | null> {
    const result = await this.database.query<{
      storagePath: string;
      mimeType: string;
    }>(
      `SELECT v.storage_path AS "storagePath", v.mime_type AS "mimeType"
         FROM naiskos.media_variants v
         JOIN naiskos.frame_media fm
           ON fm.variant_id = v.id
           OR fm.poster_variant_id = v.id
           OR fm.thumbnail_variant_id = v.id
        WHERE fm.frame_id = $1 AND v.id = $2 AND fm.deleted_at IS NULL LIMIT 1`,
      [frameId, variantId],
    );
    return oneOrNull(result.rows);
  }

  async recordTelemetry(
    frameId: string,
    telemetry: {
      state: string;
      manifestVersion: number;
      diskUsedPercent: number;
      diskTotalBytes?: number;
      diskUsedBytes?: number;
      diskAvailableBytes?: number;
      diskReservedBytes?: number;
      frameDataBytes?: number;
      mediaDataBytes?: number;
      lastError: string | null;
      lastSyncAt: string | null;
    },
  ): Promise<void> {
    await transaction(this.database, async (client) => {
      const previous = await client.query<{ diskUsedPercent: number | null }>(
        `SELECT disk_used_percent::double precision AS "diskUsedPercent"
           FROM naiskos.frame_runtime WHERE frame_id=$1 FOR UPDATE`,
        [frameId],
      );
      await client.query(
        `INSERT INTO naiskos.frame_runtime
         (frame_id, installed_version, agent_state, disk_used_percent,
          disk_total_bytes, disk_used_bytes, disk_available_bytes,
          disk_reserved_bytes, frame_data_bytes, media_data_bytes,
          last_error, last_seen_at, last_sync_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now(),$12)
       ON CONFLICT (frame_id) DO UPDATE SET
         installed_version=EXCLUDED.installed_version, agent_state=EXCLUDED.agent_state,
         disk_used_percent=EXCLUDED.disk_used_percent,
         disk_total_bytes=COALESCE(EXCLUDED.disk_total_bytes, naiskos.frame_runtime.disk_total_bytes),
         disk_used_bytes=COALESCE(EXCLUDED.disk_used_bytes, naiskos.frame_runtime.disk_used_bytes),
         disk_available_bytes=COALESCE(EXCLUDED.disk_available_bytes, naiskos.frame_runtime.disk_available_bytes),
         disk_reserved_bytes=COALESCE(EXCLUDED.disk_reserved_bytes, naiskos.frame_runtime.disk_reserved_bytes),
         frame_data_bytes=COALESCE(EXCLUDED.frame_data_bytes, naiskos.frame_runtime.frame_data_bytes),
         media_data_bytes=COALESCE(EXCLUDED.media_data_bytes, naiskos.frame_runtime.media_data_bytes),
         last_error=EXCLUDED.last_error,
         last_seen_at=now(), last_sync_at=EXCLUDED.last_sync_at`,
        [
          frameId,
          telemetry.manifestVersion,
          telemetry.state,
          telemetry.diskUsedPercent,
          telemetry.diskTotalBytes ?? null,
          telemetry.diskUsedBytes ?? null,
          telemetry.diskAvailableBytes ?? null,
          telemetry.diskReservedBytes ?? null,
          telemetry.frameDataBytes ?? null,
          telemetry.mediaDataBytes ?? null,
          telemetry.lastError,
          telemetry.lastSyncAt,
        ],
      );

      const wasBlocked = Number(previous.rows[0]?.diskUsedPercent ?? 0) >= 90;
      const isBlocked = telemetry.diskUsedPercent >= 90;
      if (isBlocked && !wasBlocked) {
        await upsertFrameNotification(client, {
          frameId,
          kind: "storage.capacity.blocked",
          severity: "error",
          title: "Almacenamiento casi lleno",
          message:
            "Naiskos alcanzó el 90 % de uso. No descargará contenido nuevo hasta liberar espacio.",
          dedupeKey: "storage-capacity",
          details: { diskUsedPercent: telemetry.diskUsedPercent },
        });
        await this.audit(client, "storage.capacity.blocked", frameId, null, {
          diskUsedPercent: telemetry.diskUsedPercent,
        });
      } else if (!isBlocked && wasBlocked) {
        await resolveFrameNotification(client, frameId, "storage-capacity");
        const released = await client.query(
          `UPDATE naiskos.frame_media SET sync_status='active'
            WHERE frame_id=$1 AND deleted_at IS NULL
              AND sync_status='pending_capacity'`,
          [frameId],
        );
        if (released.rowCount) {
          await client.query(
            `UPDATE naiskos.frames SET manifest_version=manifest_version+1,
                    updated_at=now() WHERE id=$1`,
            [frameId],
          );
        }
        await this.audit(client, "storage.capacity.recovered", frameId, null, {
          diskUsedPercent: telemetry.diskUsedPercent,
          releasedMedia: released.rowCount ?? 0,
        });
      }
    });
  }

  async recordHeartbeat(
    frameId: string,
    heartbeat: HeartbeatTelemetry,
  ): Promise<void> {
    await this.database.query(
      `INSERT INTO naiskos.frame_runtime
         (frame_id, installed_version, agent_state, last_error, last_seen_at,
          last_sync_at, telemetry_schema_version, last_heartbeat_at,
          observed_at, uptime_seconds)
       VALUES ($1,$2,$3,$4,now(),$5,$6,now(),$7,$8)
       ON CONFLICT (frame_id) DO UPDATE SET
         installed_version=EXCLUDED.installed_version,
         agent_state=EXCLUDED.agent_state,
         last_error=EXCLUDED.last_error,
         last_seen_at=now(), last_sync_at=EXCLUDED.last_sync_at,
         telemetry_schema_version=EXCLUDED.telemetry_schema_version,
         last_heartbeat_at=now(), observed_at=EXCLUDED.observed_at,
         uptime_seconds=EXCLUDED.uptime_seconds`,
      [
        frameId,
        heartbeat.installedManifestVersion,
        heartbeat.agentState,
        heartbeat.lastErrorCode,
        heartbeat.lastSyncAt,
        heartbeat.schemaVersion,
        heartbeat.observedAt,
        heartbeat.uptimeSeconds,
      ],
    );
  }

  async recordFullTelemetry(
    frameId: string,
    telemetry: FullTelemetry,
  ): Promise<TelemetryAlertTransition[]> {
    return transaction(this.database, async (client) => {
      const frameResult = await client.query<{ name: string; diskUsedPercent: number | null }>(
        `SELECT f.name, r.disk_used_percent::double precision AS "diskUsedPercent"
           FROM naiskos.frames f
           LEFT JOIN naiskos.frame_runtime r ON r.frame_id=f.id
          WHERE f.id=$1 FOR UPDATE OF f`,
        [frameId],
      );
      const frameName = frameResult.rows[0]?.name ?? frameId;
      const wasStorageBlocked = Number(frameResult.rows[0]?.diskUsedPercent ?? 0) >= 90;
      const memoryUsedPercent = telemetry.memory.totalBytes > 0
        ? telemetry.memory.usedBytes / telemetry.memory.totalBytes * 100
        : 0;
      await client.query(
        `INSERT INTO naiskos.frame_runtime
           (frame_id, installed_version, agent_state, disk_used_percent,
            disk_total_bytes, disk_used_bytes, disk_available_bytes,
            frame_data_bytes, media_data_bytes, last_error, last_seen_at,
            last_sync_at, telemetry_schema_version, last_heartbeat_at,
            last_full_telemetry_at, observed_at, uptime_seconds,
            temperature_c, throttled_mask, memory_total_bytes,
            memory_used_bytes, memory_available_bytes, swap_total_bytes,
            swap_used_bytes, telemetry)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),$11,$12,now(),now(),
                 $13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
         ON CONFLICT (frame_id) DO UPDATE SET
           installed_version=EXCLUDED.installed_version,
           agent_state=EXCLUDED.agent_state,
           disk_used_percent=EXCLUDED.disk_used_percent,
           disk_total_bytes=EXCLUDED.disk_total_bytes,
           disk_used_bytes=EXCLUDED.disk_used_bytes,
           disk_available_bytes=EXCLUDED.disk_available_bytes,
           frame_data_bytes=EXCLUDED.frame_data_bytes,
           media_data_bytes=EXCLUDED.media_data_bytes,
           last_error=EXCLUDED.last_error, last_seen_at=now(),
           last_sync_at=EXCLUDED.last_sync_at,
           telemetry_schema_version=EXCLUDED.telemetry_schema_version,
           last_heartbeat_at=now(), last_full_telemetry_at=now(),
           observed_at=EXCLUDED.observed_at, uptime_seconds=EXCLUDED.uptime_seconds,
           temperature_c=EXCLUDED.temperature_c,
           throttled_mask=EXCLUDED.throttled_mask,
           memory_total_bytes=EXCLUDED.memory_total_bytes,
           memory_used_bytes=EXCLUDED.memory_used_bytes,
           memory_available_bytes=EXCLUDED.memory_available_bytes,
           swap_total_bytes=EXCLUDED.swap_total_bytes,
           swap_used_bytes=EXCLUDED.swap_used_bytes,
           telemetry=EXCLUDED.telemetry`,
        [
          frameId,
          telemetry.sync.installedManifestVersion,
          telemetry.sync.state === "error" ? "error" : "ready",
          telemetry.storage.usedPercent,
          telemetry.storage.totalBytes,
          telemetry.storage.usedBytes,
          telemetry.storage.availableBytes,
          telemetry.storage.frameDataBytes,
          telemetry.storage.mediaDataBytes,
          telemetry.sync.lastErrorCode,
          telemetry.sync.lastSuccessAt,
          telemetry.schemaVersion,
          telemetry.observedAt,
          telemetry.uptimeSeconds,
          telemetry.thermal.temperatureCelsius,
          telemetry.thermal.throttledMask,
          telemetry.memory.totalBytes,
          telemetry.memory.usedBytes,
          telemetry.memory.availableBytes,
          telemetry.memory.swapTotalBytes,
          telemetry.memory.swapUsedBytes,
          JSON.stringify(telemetry),
        ],
      );
      await client.query(
        `INSERT INTO naiskos.frame_telemetry_samples
           (frame_id, observed_at, temperature_c, throttled_mask,
            disk_used_percent, memory_used_percent, payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          frameId,
          telemetry.observedAt,
          telemetry.thermal.temperatureCelsius,
          telemetry.thermal.throttledMask,
          telemetry.storage.usedPercent,
          memoryUsedPercent,
          JSON.stringify(telemetry),
        ],
      );

      const transitions: TelemetryAlertTransition[] = [];
      const temperature = telemetry.thermal.temperatureCelsius;
      transitions.push(...await this.transitionTelemetryAlert(client, frameId, frameName, {
        active: temperature !== null && temperature >= 75,
        recover: temperature === null || temperature < 70,
        kind: "system.temperature",
        severity: temperature !== null && temperature >= 80 ? "error" : "warning",
        title: temperature !== null && temperature >= 80 ? "Temperatura crítica" : "Temperatura elevada",
        message: temperature === null ? "Temperatura no disponible." : `El marco reporta ${temperature.toFixed(1)} °C.`,
        dedupeKey: "system-temperature",
        details: { temperatureCelsius: temperature },
      }));
      const mask = telemetry.thermal.throttledMask;
      transitions.push(...await this.transitionTelemetryAlert(client, frameId, frameName, {
        active: mask !== null && mask !== "0x0",
        recover: mask === "0x0",
        kind: "system.throttling",
        severity: "error",
        title: "Throttling o subtensión detectados",
        message: `La Raspberry reporta el indicador ${mask ?? "desconocido"}.`,
        dedupeKey: "system-throttling",
        details: { throttledMask: mask },
      }));
      transitions.push(...await this.transitionTelemetryAlert(client, frameId, frameName, {
        active: telemetry.storage.usedPercent >= 80 && telemetry.storage.usedPercent < 90,
        recover: telemetry.storage.usedPercent < 75 || telemetry.storage.usedPercent >= 90,
        kind: "storage.capacity.warning",
        severity: "warning",
        title: "Almacenamiento alto",
        message: `El almacenamiento está al ${telemetry.storage.usedPercent.toFixed(1)} %.`,
        dedupeKey: "storage-warning",
        details: { diskUsedPercent: telemetry.storage.usedPercent },
      }));
      transitions.push(...await this.transitionTelemetryAlert(client, frameId, frameName, {
        active: telemetry.storage.usedPercent >= 90,
        recover: telemetry.storage.usedPercent < 90,
        kind: "storage.capacity.blocked",
        severity: "error",
        title: "Almacenamiento casi lleno",
        message: "Naiskos alcanzó el 90 % de uso. No descargará contenido nuevo hasta liberar espacio.",
        dedupeKey: "storage-capacity",
        details: { diskUsedPercent: telemetry.storage.usedPercent },
      }));
      transitions.push(...await this.transitionTelemetryAlert(client, frameId, frameName, {
        active: memoryUsedPercent >= 85,
        recover: memoryUsedPercent < 80,
        kind: "system.memory",
        severity: memoryUsedPercent >= 95 ? "error" : "warning",
        title: memoryUsedPercent >= 95 ? "Memoria crítica" : "Uso alto de memoria",
        message: `La memoria está al ${memoryUsedPercent.toFixed(1)} %.`,
        dedupeKey: "system-memory",
        details: { memoryUsedPercent },
      }));
      const swapUsedPercent = telemetry.memory.swapTotalBytes > 0
        ? telemetry.memory.swapUsedBytes / telemetry.memory.swapTotalBytes * 100
        : 0;
      transitions.push(...await this.transitionTelemetryAlert(client, frameId, frameName, {
        active: telemetry.memory.swapUsedBytes >= 128 * 1024 * 1024 && swapUsedPercent >= 75,
        recover: swapUsedPercent < 50,
        kind: "system.swap",
        severity: "warning",
        title: "Uso alto de swap",
        message: `La swap está al ${swapUsedPercent.toFixed(1)} %.`,
        dedupeKey: "system-swap",
        details: { swapUsedPercent, swapUsedBytes: telemetry.memory.swapUsedBytes },
      }));
      const lastSuccessAgeMs = telemetry.sync.lastSuccessAt
        ? Date.now() - Date.parse(telemetry.sync.lastSuccessAt)
        : Number.POSITIVE_INFINITY;
      transitions.push(...await this.transitionTelemetryAlert(client, frameId, frameName, {
        active: lastSuccessAgeMs > 15 * 60_000,
        recover: lastSuccessAgeMs <= 10 * 60_000,
        kind: "sync.stale",
        severity: "warning",
        title: "Sincronización atrasada",
        message: telemetry.sync.lastSuccessAt
          ? "El marco no completa una sincronización desde hace más de 15 minutos."
          : "El marco todavía no reporta una sincronización exitosa.",
        dedupeKey: "sync-stale",
        details: { lastSuccessAt: telemetry.sync.lastSuccessAt },
      }));
      transitions.push(...await this.transitionTelemetryAlert(client, frameId, frameName, {
        active: telemetry.sync.pendingOutbox >= 100,
        recover: telemetry.sync.pendingOutbox < 20,
        kind: "sync.outbox",
        severity: "warning",
        title: "Eventos locales pendientes",
        message: `El marco conserva ${telemetry.sync.pendingOutbox} eventos sin entregar.`,
        dedupeKey: "sync-outbox",
        details: { pendingOutbox: telemetry.sync.pendingOutbox },
      }));
      transitions.push(...await this.transitionTelemetryAlert(client, frameId, frameName, {
        active: telemetry.sync.desiredManifestVersion !== telemetry.sync.installedManifestVersion,
        recover: telemetry.sync.desiredManifestVersion === telemetry.sync.installedManifestVersion,
        kind: "sync.manifest",
        severity: "warning",
        title: "Manifiesto pendiente",
        message: `Asignado ${telemetry.sync.desiredManifestVersion}; instalado ${telemetry.sync.installedManifestVersion}.`,
        dedupeKey: "sync-manifest",
        details: {
          desiredManifestVersion: telemetry.sync.desiredManifestVersion,
          installedManifestVersion: telemetry.sync.installedManifestVersion,
        },
      }));
      if (wasStorageBlocked && telemetry.storage.usedPercent < 90) {
        const released = await client.query(
          `UPDATE naiskos.frame_media SET sync_status='active'
            WHERE frame_id=$1 AND deleted_at IS NULL
              AND sync_status='pending_capacity'`,
          [frameId],
        );
        if (released.rowCount) {
          await client.query(
            `UPDATE naiskos.frames SET manifest_version=manifest_version+1,
                    updated_at=now() WHERE id=$1`,
            [frameId],
          );
        }
      }
      for (const [key, label, state] of [
        ["service-chromium", "Chromium", telemetry.services.chromium],
        ["service-kiosk", "Lanzador del kiosco", telemetry.services.kioskLauncher],
      ] as const) {
        transitions.push(...await this.transitionTelemetryAlert(client, frameId, frameName, {
          active: state === "inactive" || state === "failed",
          recover: state === "active",
          kind: `service.${key.replace("service-", "")}`,
          severity: "error",
          title: `${label} no está activo`,
          message: `${label} reporta estado «${state}».`,
          dedupeKey: key,
          details: { state },
        }));
      }
      for (const alert of [
        {
          active: !telemetry.display.connected,
          recover: telemetry.display.connected,
          kind: "hardware.display",
          severity: "error" as const,
          title: "Pantalla no detectada",
          message: `No se detecta ${telemetry.display.connector}.`,
          dedupeKey: "hardware-display",
          details: telemetry.display,
        },
        {
          active: !telemetry.audio.available,
          recover: telemetry.audio.available,
          kind: "hardware.audio",
          severity: "warning" as const,
          title: "Audio no disponible",
          message: "El marco no detecta una salida de audio.",
          dedupeKey: "hardware-audio",
          details: telemetry.audio,
        },
        {
          active: !telemetry.clock.synchronized,
          recover: telemetry.clock.synchronized,
          kind: "system.clock",
          severity: "warning" as const,
          title: "Reloj no sincronizado",
          message: `El reloj del marco no está sincronizado (${telemetry.clock.timezone}).`,
          dedupeKey: "system-clock",
          details: telemetry.clock,
        },
      ]) transitions.push(...await this.transitionTelemetryAlert(client, frameId, frameName, alert));
      return transitions;
    });
  }

  async listFleetStatus(): Promise<FleetFrameStatus[]> {
    const result = await this.database.query<FleetFrameStatus>(
      `SELECT f.id, f.name, f.status AS "frameStatus",
              r.agent_state AS "agentState", r.last_seen_at AS "lastSeenAt",
              r.last_full_telemetry_at AS "lastFullTelemetryAt",
              r.temperature_c::double precision AS "temperatureC",
              r.disk_used_percent::double precision AS "diskUsedPercent",
              CASE WHEN r.memory_total_bytes > 0
                THEN r.memory_used_bytes::double precision / r.memory_total_bytes * 100
                ELSE NULL END AS "memoryUsedPercent",
              r.telemetry->'software'->>'releaseId' AS "releaseId",
              f.manifest_version::double precision AS "manifestVersion",
              count(n.id)::integer AS "activeAlerts"
         FROM naiskos.frames f
         LEFT JOIN naiskos.frame_runtime r ON r.frame_id=f.id
         LEFT JOIN naiskos.frame_notifications n ON n.frame_id=f.id
              AND n.resolved_at IS NULL AND n.dismissed_at IS NULL
        WHERE f.status <> 'disabled'
        GROUP BY f.id, r.frame_id
        ORDER BY f.name`,
    );
    return result.rows;
  }

  async findFleetFrame(query: string): Promise<FleetFrameStatus | null> {
    const frames = await this.listFleetStatus();
    const needle = query.trim().toLocaleLowerCase("es");
    return frames.find((frame) =>
      frame.id === query || frame.id.startsWith(query) || frame.name.toLocaleLowerCase("es") === needle
    ) ?? null;
  }

  async listFleetAlerts(): Promise<FleetAlert[]> {
    const result = await this.database.query<FleetAlert>(
      `SELECT n.id, n.frame_id AS "frameId", f.name AS "frameName",
              n.kind, n.severity, n.title, n.message,
              n.created_at AS "createdAt"
         FROM naiskos.frame_notifications n
         JOIN naiskos.frames f ON f.id=n.frame_id
        WHERE n.resolved_at IS NULL AND n.dismissed_at IS NULL
        ORDER BY CASE n.severity WHEN 'error' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
                 n.created_at DESC
        LIMIT 100`,
    );
    return result.rows;
  }

  async evaluateOfflineFrames(minutes = 15): Promise<TelemetryAlertTransition[]> {
    return transaction(this.database, async (client) => {
      const result = await client.query<{ id: string; name: string; offline: boolean }>(
        `SELECT f.id, f.name,
                (r.last_seen_at IS NULL OR r.last_seen_at < now() - make_interval(mins => $1)) AS offline
           FROM naiskos.frames f
           LEFT JOIN naiskos.frame_runtime r ON r.frame_id=f.id
          WHERE f.status='active' AND f.created_at < now() - make_interval(mins => $1)
          FOR UPDATE OF f`,
        [minutes],
      );
      const transitions: TelemetryAlertTransition[] = [];
      for (const frame of result.rows) {
        transitions.push(...await this.transitionTelemetryAlert(client, frame.id, frame.name, {
          active: frame.offline,
          recover: !frame.offline,
          kind: "fleet.offline",
          severity: "error",
          title: "Marco sin contacto",
          message: `El marco no reporta desde hace más de ${minutes} minutos.`,
          dedupeKey: "fleet-offline",
          details: { thresholdMinutes: minutes },
        }));
      }
      return transitions;
    });
  }

  async pruneTelemetrySamples(retentionDays: number): Promise<number> {
    const result = await this.database.query(
      `DELETE FROM naiskos.frame_telemetry_samples
        WHERE received_at < now() - make_interval(days => $1)`,
      [retentionDays],
    );
    return result.rowCount ?? 0;
  }

  private async transitionTelemetryAlert(
    client: PoolClient,
    frameId: string,
    frameName: string,
    alert: {
      active: boolean;
      recover: boolean;
      kind: string;
      severity: "info" | "warning" | "error";
      title: string;
      message: string;
      dedupeKey: string;
      details: Record<string, unknown>;
    },
  ): Promise<TelemetryAlertTransition[]> {
    const current = await client.query<{ active: boolean }>(
      `SELECT resolved_at IS NULL AS active
         FROM naiskos.frame_notifications
        WHERE frame_id=$1 AND dedupe_key=$2 FOR UPDATE`,
      [frameId, alert.dedupeKey],
    );
    const wasActive = current.rows[0]?.active ?? false;
    if (alert.active) {
      if (!wasActive) {
        await upsertFrameNotification(client, { frameId, ...alert });
        await this.audit(client, `${alert.kind}.detected`, frameId, null, alert.details);
        return [{ frameId, frameName, status: "opened", severity: alert.severity, kind: alert.kind, title: alert.title, message: alert.message }];
      }
      await client.query(
        `UPDATE naiskos.frame_notifications
            SET severity=$3, title=$4, message=$5, details=$6, updated_at=now()
          WHERE frame_id=$1 AND dedupe_key=$2 AND resolved_at IS NULL`,
        [frameId, alert.dedupeKey, alert.severity, alert.title, alert.message, JSON.stringify(alert.details)],
      );
      return [];
    }
    if (wasActive && alert.recover) {
      await resolveFrameNotification(client, frameId, alert.dedupeKey);
      await this.audit(client, `${alert.kind}.recovered`, frameId, null, alert.details);
      return [{ frameId, frameName, status: "resolved", severity: "info", kind: alert.kind, title: alert.title, message: alert.message }];
    }
    return [];
  }

  async getNotifications(frameId: string): Promise<FrameNotificationRecord[]> {
    const result = await this.database.query<FrameNotificationRecord>(
      `SELECT id, kind, severity, title, message,
              created_at AS "createdAt", updated_at AS "updatedAt",
              read_at AS "readAt", resolved_at AS "resolvedAt"
         FROM naiskos.frame_notifications
        WHERE frame_id=$1 AND dismissed_at IS NULL
        ORDER BY created_at DESC LIMIT 100`,
      [frameId],
    );
    return result.rows;
  }

  async applyDeviceEvents(
    frameId: string,
    events: Array<Record<string, unknown>>,
    transitions: TelemetryAlertTransition[] = [],
  ): Promise<string[]> {
    return transaction(this.database, async (client) => {
      const accepted: string[] = [];
      let frameName: string | null = null;
      for (const event of events.slice(0, 100)) {
        const id = String(event.id ?? "");
        const kind = String(event.type ?? "");
        if (!isUuid(id) || !kind) continue;
        const inserted = await client.query(
          `INSERT INTO naiskos.device_events (id, frame_id, kind, payload, occurred_at)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING`,
          [
            id,
            frameId,
            kind,
            JSON.stringify(event),
            event.at ?? new Date().toISOString(),
          ],
        );
        accepted.push(id);
        if (!inserted.rowCount) continue;
        if (kind === "settings.updated" && event.settings) {
          await client.query(
            `UPDATE naiskos.frames SET settings=$2,
                    settings_revision=settings_revision+1,
                    manifest_version=manifest_version+1, updated_at=now()
              WHERE id=$1`,
            [frameId, JSON.stringify(event.settings)],
          );
        } else if (kind === "settings.reset") {
          await client.query(
            `UPDATE naiskos.frames SET settings=DEFAULT,
                    settings_revision=settings_revision+1,
                    manifest_version=manifest_version+1, updated_at=now()
              WHERE id=$1`,
            [frameId],
          );
        } else if (kind === "media.fit-mode.updated") {
          const mediaId = String(event.mediaId ?? "");
          const fitMode = String(event.fitMode ?? "");
          if (!isUuid(mediaId)) {
            await this.audit(client, `${kind}.ignored`, frameId, null, {
              deviceEventId: id,
              reason: "legacy-media-id",
              legacyMediaId: mediaId,
            });
            continue;
          }
          if (fitMode !== "inherit" && fitMode !== "contain" && fitMode !== "cover") {
            await this.audit(client, `${kind}.ignored`, frameId, null, {
              deviceEventId: id,
              reason: "invalid-fit-mode",
            });
            continue;
          }
          const updated = await client.query(
            `UPDATE naiskos.frame_media SET fit_mode=$3 WHERE frame_id=$1 AND media_id=$2 AND deleted_at IS NULL`,
            [frameId, mediaId, fitMode],
          );
          if (updated.rowCount) {
            await client.query(
              `UPDATE naiskos.frames SET manifest_version=manifest_version+1, updated_at=now() WHERE id=$1`,
              [frameId],
            );
          } else {
            await this.audit(client, `${kind}.ignored`, frameId, null, {
              deviceEventId: id,
              reason: "media-not-found",
              mediaId,
            });
            continue;
          }
        } else if (kind === "media.deleted") {
          const mediaId = String(event.mediaId ?? "");
          if (!isUuid(mediaId)) {
            await this.audit(client, `${kind}.ignored`, frameId, null, {
              deviceEventId: id,
              reason: "invalid-media-id",
            });
            continue;
          }
          const deleted = await client.query(
            `UPDATE naiskos.frame_media
                SET deleted_at=now(), purge_after=now() + interval '30 days'
              WHERE frame_id=$1 AND media_id=$2 AND deleted_at IS NULL`,
            [frameId, mediaId],
          );
          if (!deleted.rowCount) {
            await this.audit(client, `${kind}.ignored`, frameId, null, {
              deviceEventId: id,
              reason: "media-not-found",
              mediaId,
            });
            continue;
          }
          await client.query(
            `UPDATE naiskos.jobs SET status='failed', completed_at=now(),
                    last_error='Medio eliminado antes de completar la rotación'
              WHERE kind='media.rotate' AND status='pending'
                AND payload->>'frameId'=$1 AND payload->>'mediaId'=$2`,
            [frameId, mediaId],
          );
          await client.query(
            `UPDATE naiskos.frames SET manifest_version=manifest_version+1, updated_at=now()
              WHERE id=$1`,
            [frameId],
          );
        } else if (kind === "media.rotation.requested") {
          const mediaId = String(event.mediaId ?? "");
          const rotationDegrees = Number(event.rotationDegrees);
          if (!isUuid(mediaId) || ![0, 90, 180, 270].includes(rotationDegrees)) {
            await this.audit(client, `${kind}.ignored`, frameId, null, {
              deviceEventId: id,
              reason: !isUuid(mediaId) ? "invalid-media-id" : "invalid-rotation",
              mediaId,
              rotationDegrees,
            });
            continue;
          }
          const current = await client.query<{ rotationDegrees: number }>(
            `SELECT rotation_degrees AS "rotationDegrees"
               FROM naiskos.frame_media
              WHERE frame_id=$1 AND media_id=$2 AND deleted_at IS NULL
              FOR UPDATE`,
            [frameId, mediaId],
          );
          if (!current.rows[0]) {
            await this.audit(client, `${kind}.ignored`, frameId, null, {
              deviceEventId: id,
              reason: "media-not-found",
              mediaId,
            });
            continue;
          }
          if (current.rows[0].rotationDegrees === rotationDegrees) {
            await this.audit(client, `${kind}.ignored`, frameId, null, {
              deviceEventId: id,
              reason: "already-at-angle",
              mediaId,
              rotationDegrees,
            });
            continue;
          }
          await client.query(
            `UPDATE naiskos.jobs SET status='failed', completed_at=now(),
                    last_error='Sustituida por una solicitud de rotación posterior'
              WHERE kind='media.rotate' AND status='pending'
                AND payload->>'frameId'=$1 AND payload->>'mediaId'=$2`,
            [frameId, mediaId],
          );
          await client.query(
            `INSERT INTO naiskos.jobs (id, kind, payload, status, available_at)
             VALUES ($1, 'media.rotate', $2, 'pending', now())`,
            [
              randomUUID(),
              JSON.stringify({
                frameId,
                mediaId,
                rotationDegrees: rotationDegrees as 0 | 90 | 180 | 270,
                deviceEventId: id,
              } satisfies RotateMediaJobPayload),
            ],
          );
        } else if (kind === "notification.read" || kind === "notification.dismissed") {
          const notificationId = String(event.notificationId ?? "");
          if (!isUuid(notificationId)) {
            await this.audit(client, `${kind}.ignored`, frameId, null, {
              deviceEventId: id,
              reason: "invalid-notification-id",
            });
            continue;
          }
          const updated = await client.query(
            kind === "notification.read"
              ? `UPDATE naiskos.frame_notifications
                    SET read_at=COALESCE(read_at, now()), updated_at=now()
                  WHERE id=$1 AND frame_id=$2`
              : `UPDATE naiskos.frame_notifications
                    SET dismissed_at=COALESCE(dismissed_at, now()),
                        read_at=COALESCE(read_at, now()), updated_at=now()
                  WHERE id=$1 AND frame_id=$2`,
            [notificationId, frameId],
          );
          if (!updated.rowCount) {
            await this.audit(client, `${kind}.ignored`, frameId, null, {
              deviceEventId: id,
              reason: "notification-not-found",
              notificationId,
            });
            continue;
          }
        } else if (kind === "software.release.status") {
          const campaignId = String(event.campaignId ?? "");
          const releaseId = String(event.releaseId ?? "");
          const status = String(event.status ?? "");
          const allowed = new Set([
            "downloading", "verified", "awaiting_window", "activating",
            "observing", "installed", "failed", "rolled_back",
          ]);
          if (!isUuid(campaignId) || !allowed.has(status)) {
            await this.audit(client, `${kind}.ignored`, frameId, null, {
              deviceEventId: id,
              reason: "invalid-release-status",
            });
            continue;
          }
          const updated = await client.query(
            `UPDATE naiskos.release_assignments a SET
                status=$4,
                progress_percent=CASE WHEN $4='installed' THEN 100 ELSE $5 END,
                last_error=$6,
                downloaded_at=CASE WHEN $4 IN ('verified','awaiting_window') THEN COALESCE(downloaded_at,now()) ELSE downloaded_at END,
                activated_at=CASE WHEN $4 IN ('observing','installed') THEN COALESCE(activated_at,now()) ELSE activated_at END,
                observed_at=CASE WHEN $4='installed' THEN now() ELSE observed_at END,
                updated_at=now()
              FROM naiskos.release_campaigns c
             WHERE a.campaign_id=$1 AND a.frame_id=$2 AND c.id=a.campaign_id
               AND c.release_id=$3`,
            [
              campaignId,
              frameId,
              releaseId,
              status,
              Number.isFinite(Number(event.progressPercent))
                ? Number(event.progressPercent)
                : null,
              typeof event.error === "string" ? event.error.slice(0, 1_000) : null,
            ],
          );
          if (!updated.rowCount) {
            await this.audit(client, `${kind}.ignored`, frameId, null, {
              deviceEventId: id,
              reason: "assignment-not-found",
              campaignId,
              releaseId,
            });
            continue;
          }
          if (status === "installed" || status === "rolled_back" || status === "failed") {
            await upsertFrameNotification(client, {
              frameId,
              kind: "software.release",
              severity: status === "installed" ? "info" : "error",
              title:
                status === "installed"
                  ? "Naiskos fue actualizado"
                  : status === "rolled_back"
                    ? "Naiskos revirtió una actualización"
                    : "Falló una actualización de Naiskos",
              message:
                status === "installed"
                  ? `La versión ${releaseId} quedó instalada y verificada.`
                  : `${releaseId}: ${typeof event.error === "string" ? event.error : status}`,
              dedupeKey: `software-release-${releaseId}`,
              details: { campaignId, releaseId, status },
            });
          }
          if (status === "failed" || status === "rolled_back") {
            const failure = await client.query<{
              deployed: number;
              failed: number;
              threshold: number;
            }>(
              `SELECT count(*) FILTER (
                        WHERE CASE a.stage WHEN 'pilot' THEN 1 WHEN 'ten-percent' THEN 2 ELSE 3 END
                           <= CASE c.active_stage WHEN 'pilot' THEN 1 WHEN 'ten-percent' THEN 2 ELSE 3 END
                      )::integer AS deployed,
                      count(*) FILTER (WHERE a.status IN ('failed','rolled_back'))::integer AS failed,
                      c.failure_threshold_percent::float8 AS threshold
                 FROM naiskos.release_campaigns c
                 JOIN naiskos.release_assignments a ON a.campaign_id=c.id
                WHERE c.id=$1 GROUP BY c.id`,
              [campaignId],
            );
            const summary = failure.rows[0];
            if (
              summary && summary.deployed > 0 &&
              (summary.failed / summary.deployed) * 100 >= summary.threshold
            ) {
              await client.query(
                `UPDATE naiskos.release_campaigns SET status='paused'
                  WHERE id=$1 AND status='approved'`,
                [campaignId],
              );
              await this.audit(client, "release.campaign.auto-paused", frameId, null, {
                campaignId,
                releaseId,
                failed: summary.failed,
                deployed: summary.deployed,
                threshold: summary.threshold,
              });
            }
          } else if (status === "installed") {
            const campaign = await client.query<{
              activeStage: "pilot" | "ten-percent" | "remainder";
              remaining: number;
              nextStage: "ten-percent" | "remainder" | null;
            }>(
              `SELECT c.active_stage AS "activeStage",
                      count(*) FILTER (
                        WHERE CASE a.stage WHEN 'pilot' THEN 1 WHEN 'ten-percent' THEN 2 ELSE 3 END
                           <= CASE c.active_stage WHEN 'pilot' THEN 1 WHEN 'ten-percent' THEN 2 ELSE 3 END
                          AND a.status <> 'installed'
                      )::integer AS remaining,
                      CASE min(
                        CASE a.stage WHEN 'pilot' THEN 1 WHEN 'ten-percent' THEN 2 ELSE 3 END
                      ) FILTER (
                        WHERE CASE a.stage WHEN 'pilot' THEN 1 WHEN 'ten-percent' THEN 2 ELSE 3 END
                           > CASE c.active_stage WHEN 'pilot' THEN 1 WHEN 'ten-percent' THEN 2 ELSE 3 END
                      ) WHEN 2 THEN 'ten-percent' WHEN 3 THEN 'remainder' ELSE NULL END AS "nextStage"
                 FROM naiskos.release_campaigns c
                 JOIN naiskos.release_assignments a ON a.campaign_id=c.id
                WHERE c.id=$1 AND c.status='approved'
                GROUP BY c.id`,
              [campaignId],
            );
            const current = campaign.rows[0];
            if (current && current.remaining === 0) {
              const next = current.nextStage;
              if (next) {
                await client.query(
                  `UPDATE naiskos.release_campaigns SET active_stage=$2 WHERE id=$1`,
                  [campaignId, next],
                );
                await this.audit(client, "release.campaign.stage-advanced", frameId, null, {
                  campaignId,
                  releaseId,
                  from: current.activeStage,
                  to: next,
                });
              } else {
                await client.query(
                  `UPDATE naiskos.release_campaigns
                      SET status='completed', completed_at=now() WHERE id=$1`,
                  [campaignId],
                );
                await this.audit(client, "release.campaign.completed", frameId, null, {
                  campaignId,
                  releaseId,
                });
              }
            }
          }
        } else if (kind === "system.maintenance.status") {
          const mode = String(event.mode ?? "");
          const status = String(event.status ?? "");
          const packagesChanged = Number(event.packagesChanged);
          const packagesPending = Number(event.packagesPending);
          const rebootRequired = event.rebootRequired === true;
          const campaignId = typeof event.campaignId === "string" ? event.campaignId : null;
          const attemptId = typeof event.attemptId === "string" ? event.attemptId : null;
          const errorCode = typeof event.errorCode === "string" ? event.errorCode.slice(0, 80) : null;
          const error = typeof event.error === "string" ? event.error.slice(0, 1_000) : null;
          if (
            !["security", "general"].includes(mode) ||
            !["authorized", "preflight", "running", "deferred", "reboot_pending", "verifying", "succeeded", "failed"].includes(status) ||
            !Number.isSafeInteger(packagesChanged) || packagesChanged < 0 || packagesChanged > 10_000 ||
            !Number.isSafeInteger(packagesPending) || packagesPending < 0 || packagesPending > 10_000 ||
            (campaignId !== null && !isUuid(campaignId)) ||
            (attemptId !== null && !isUuid(attemptId)) ||
            (mode === "general" && !campaignId && !["deferred", "failed"].includes(status))
          ) {
            await this.audit(client, `${kind}.ignored`, frameId, null, {
              deviceEventId: id,
              reason: "invalid-maintenance-status",
            });
            continue;
          }
          if (mode === "general" && campaignId) {
            const assignmentStatus = status === "succeeded"
              ? "observing"
              : ["authorized", "preflight"].includes(status)
                ? "running"
                : status;
            const updated = await client.query(
              `UPDATE naiskos.system_update_assignments
                  SET status=$3,packages_changed=$4,reboot_required=$5,last_error=$6,
                      started_at=CASE WHEN $3='running' THEN COALESCE(started_at,now()) ELSE started_at END,
                      last_attempt_at=now(),
                      verified_at=CASE WHEN $3='observing' THEN now() ELSE verified_at END,
                      updated_at=now()
                WHERE campaign_id=$1 AND frame_id=$2
                  AND ($7::uuid IS NULL OR attempt_id=$7)
                  AND CASE
                    WHEN $8 IN ('authorized','preflight','running','deferred')
                      THEN status IN ('assigned','running','deferred')
                    WHEN $8='reboot_pending' THEN status IN ('running','reboot_pending')
                    WHEN $8='verifying' THEN status IN ('reboot_pending','verifying')
                    WHEN $8='succeeded' THEN status IN ('running','reboot_pending','verifying','observing')
                    WHEN $8='failed' THEN status IN ('assigned','running','deferred','reboot_pending','verifying','observing')
                    ELSE false
                  END`,
              [campaignId, frameId, assignmentStatus, packagesChanged, rebootRequired, error, attemptId, status],
            );
            if (!updated.rowCount) {
              await this.audit(client, `${kind}.ignored`, frameId, null, {
                deviceEventId: id,
                reason: "system-update-assignment-not-found",
                campaignId,
              });
              continue;
            }
          }
          if (frameName === null) {
            const frame = await client.query<{ name: string }>(
              "SELECT name FROM naiskos.frames WHERE id=$1",
              [frameId],
            );
            frameName = frame.rows[0]?.name ?? frameId;
          }
          const authorizationFailure = status === "deferred" && errorCode === "authorization_failed";
          transitions.push(...await this.transitionTelemetryAlert(client, frameId, frameName, {
            active: status === "failed" || authorizationFailure,
            recover: ["authorized", "preflight", "running", "succeeded"].includes(status),
            kind: `system.maintenance.${mode}`,
            severity: "error",
            title: mode === "security"
              ? "Falló la actualización de seguridad del SO"
              : "Falló la actualización general del SO",
            message: error ?? (authorizationFailure
              ? "El marco no pudo obtener una autorización válida para el mantenimiento."
              : "La actualización terminó correctamente."),
            dedupeKey: `system-maintenance-${mode}-failed`,
            details: { mode, status, packagesChanged, packagesPending, rebootRequired, campaignId, attemptId, errorCode, deviceEventId: id },
          }));
          if (status === "succeeded") {
            transitions.push(...await this.transitionTelemetryAlert(client, frameId, frameName, {
              active: packagesPending > 0 || rebootRequired,
              recover: packagesPending === 0 && !rebootRequired,
              kind: "system.updates-pending",
              severity: "warning",
              title: rebootRequired
                ? "El sistema requiere reinicio"
                : `${packagesPending} actualización${packagesPending === 1 ? "" : "es"} del SO pendiente${packagesPending === 1 ? "" : "s"}`,
              message: rebootRequired
                ? `El mantenimiento terminó y el sistema solicita reinicio; quedan ${packagesPending} paquete${packagesPending === 1 ? "" : "s"} pendiente${packagesPending === 1 ? "" : "s"}.`
                : "El mantenimiento terminó; los paquetes restantes se evaluarán en la siguiente ventana.",
              dedupeKey: "system-updates-pending",
              details: { mode, packagesChanged, packagesPending, rebootRequired, campaignId, deviceEventId: id },
            }));
          }
          if (status === "succeeded" && (packagesChanged > 0 || rebootRequired)) {
            const title = mode === "security"
              ? "Actualización de seguridad aplicada"
              : "Actualización general del sistema aplicada";
            const message = `${packagesChanged} paquete${packagesChanged === 1 ? " fue actualizado" : "s fueron actualizados"}${rebootRequired ? "; el equipo se reiniciará dentro de la ventana nocturna" : ""}.`;
            await upsertFrameNotification(client, {
              frameId,
              kind: `system.maintenance.${mode}`,
              severity: "info",
              title,
              message,
              dedupeKey: `system-maintenance-${mode}-completed`,
              details: { mode, packagesChanged, packagesPending, rebootRequired, campaignId, deviceEventId: id },
            });
            transitions.push({
              frameId,
              frameName,
              status: "opened",
              severity: "info",
              kind: `system.maintenance.${mode}`,
              title,
              message,
            });
          }
        } else if (kind === "system.updates.checked") {
          const count = Number(event.count);
          const rebootRequired = event.rebootRequired === true;
          const error = typeof event.error === "string" ? event.error : null;
          if (!Number.isSafeInteger(count) || count < 0 || count > 10_000) {
            await this.audit(client, `${kind}.ignored`, frameId, null, {
              deviceEventId: id,
              reason: "invalid-count",
            });
            continue;
          }
          if (frameName === null) {
            const frame = await client.query<{ name: string }>(
              `SELECT name FROM naiskos.frames WHERE id=$1`,
              [frameId],
            );
            frameName = frame.rows[0]?.name ?? frameId;
          }
          transitions.push(...await this.transitionTelemetryAlert(
            client,
            frameId,
            frameName,
            {
              active: Boolean(error),
              recover: !error,
              kind: "system.update-check",
              severity: "error",
              title: "Falló la consulta de actualizaciones del SO",
              message: error ?? "La consulta diaria volvió a responder.",
              dedupeKey: "system-update-check-failed",
              details: { count, rebootRequired, deviceEventId: id },
            },
          ));
          transitions.push(...await this.transitionTelemetryAlert(
            client,
            frameId,
            frameName,
            {
              active: !error && (count > 0 || rebootRequired),
              recover: !error && count === 0 && !rebootRequired,
              kind: "system.updates-pending",
              severity: "warning",
              title: rebootRequired
                ? "El sistema requiere reinicio"
                : `${count} actualización${count === 1 ? "" : "es"} del SO pendiente${count === 1 ? "" : "s"}`,
              message: rebootRequired
                ? `Hay ${count} paquete${count === 1 ? "" : "s"} pendiente${count === 1 ? "" : "s"} y el sistema solicita reinicio.`
                : "Los parches de seguridad se instalarán de noche; las actualizaciones generales siguen la campaña mensual escalonada.",
              dedupeKey: "system-updates-pending",
              details: { count, rebootRequired, deviceEventId: id },
            },
          ));
        } else if (
          kind === "display.sleep.succeeded" ||
          kind === "display.sleep.failed" ||
          kind === "display.wake.succeeded" ||
          kind === "display.wake.failed"
        ) {
          const attempts = Number(event.attempts);
          if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 10) {
            await this.audit(client, `${kind}.ignored`, frameId, null, {
              deviceEventId: id,
              reason: "invalid-attempts",
            });
            continue;
          }
          if (frameName === null) {
            const frame = await client.query<{ name: string }>(
              `SELECT name FROM naiskos.frames WHERE id=$1`,
              [frameId],
            );
            frameName = frame.rows[0]?.name ?? frameId;
          }
          const wake = kind.startsWith("display.wake.");
          const failed = kind.endsWith(".failed");
          transitions.push(...await this.transitionTelemetryAlert(
            client,
            frameId,
            frameName,
            {
              active: failed,
              recover: !failed,
              kind: wake ? "schedule.display.wake" : "schedule.display.sleep",
              severity: wake ? "error" : "warning",
              title: wake
                ? "Falló el encendido programado de la pantalla"
                : "Falló el reposo programado de la pantalla",
              message: failed
                ? `El control de pantalla agotó ${attempts} intento${attempts === 1 ? "" : "s"}.`
                : `El control de pantalla respondió después de ${attempts} intento${attempts === 1 ? "" : "s"}.`,
              dedupeKey: wake ? "display-wake-failed" : "display-sleep-failed",
              details: { attempts, deviceEventId: id },
            },
          ));
        }
        await this.audit(client, kind, frameId, null, { deviceEventId: id });
      }
      return accepted;
    });
  }

  private async transitionTelegramUser(
    telegramId: string,
    actorTelegramId: string,
    allowedStatuses: TelegramUser["status"][],
    nextStatus: TelegramUser["status"],
    action: string,
    revokeMemberships: boolean,
  ): Promise<boolean> {
    return transaction(this.database, async (client) => {
      const result = await client.query<{ id: string; previousStatus: string }>(
        `UPDATE naiskos.telegram_users
            SET status=$3, updated_at=now()
          WHERE telegram_id=$1 AND status=ANY($2::text[])
          RETURNING id, status AS "previousStatus"`,
        [telegramId, allowedStatuses, nextStatus],
      );
      const user = result.rows[0];
      if (!user) return false;
      let revokedMembershipCount = 0;
      if (revokeMemberships) {
        const memberships = await client.query(
          `UPDATE naiskos.frame_memberships SET status='revoked', updated_at=now()
            WHERE telegram_user_id=$1 AND status='approved'`,
          [user.id],
        );
        revokedMembershipCount = memberships.rowCount ?? 0;
      }
      const actor = await client.query<{ id: string }>(
        "SELECT id FROM naiskos.telegram_users WHERE telegram_id=$1",
        [actorTelegramId],
      );
      await this.audit(client, action, null, actor.rows[0]?.id ?? null, {
        telegramId,
        actorTelegramId,
        nextStatus,
        revokedMembershipCount,
      });
      return true;
    });
  }

  async audit(
    client: Pick<PoolClient, "query">,
    action: string,
    frameId: string | null,
    actorId: string | null,
    details: object,
  ): Promise<void> {
    await client.query(
      `INSERT INTO naiskos.audit_log (frame_id, actor_telegram_user_id, action, details)
       VALUES ($1, $2, $3, $4)`,
      [frameId, actorId, action, JSON.stringify(details)],
    );
  }
}

export function orderManifestMedia<T extends Record<string, unknown>>(
  media: T[],
  order: string,
  version: number,
): T[] {
  const result = [...media];
  const timestamp = (item: T, field: string) => {
    const value = item[field];
    const time = value ? new Date(String(value)).getTime() : 0;
    return Number.isFinite(time) ? time : 0;
  };
  if (order === "oldest")
    return result.sort(
      (a, b) => timestamp(a, "receivedAt") - timestamp(b, "receivedAt"),
    );
  if (order === "shuffle") {
    return result.sort(
      (a, b) =>
        stableRank(String(a.id), version) - stableRank(String(b.id), version),
    );
  }
  return result.sort(
    (a, b) => timestamp(b, "receivedAt") - timestamp(a, "receivedAt"),
  );
}

function stableRank(id: string, version: number): number {
  let hash = version | 0;
  for (const character of id)
    hash = Math.imul(hash ^ character.charCodeAt(0), 16_777_619);
  return hash >>> 0;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

export function monthlyGeneralSchedule(now: Date): {
  period: string;
  scheduledAt: Date;
  expiresAt: Date;
} {
  // America/Lima no usa horario de verano. Se calcula en UTC-05 para que el
  // primer domingo a las 00:30 sea estable aunque el servidor use otra zona.
  const lima = new Date(now.getTime() - 5 * 60 * 60_000);
  const year = lima.getUTCFullYear();
  const month = lima.getUTCMonth();
  const firstDow = new Date(Date.UTC(year, month, 1)).getUTCDay();
  const firstSunday = 1 + ((7 - firstDow) % 7);
  const scheduledAt = new Date(Date.UTC(year, month, firstSunday, 5, 30));
  return {
    period: `${year}-${String(month + 1).padStart(2, "0")}`,
    scheduledAt,
    expiresAt: new Date(scheduledAt.getTime() + 7 * 24 * 60 * 60_000),
  };
}

function sameAutomaticLocation(
  current: { latitude: number; longitude: number },
  candidate: AutomaticLocation,
): boolean {
  return (
    Math.abs(Number(current.latitude) - candidate.latitude) <= 0.01 &&
    Math.abs(Number(current.longitude) - candidate.longitude) <= 0.01
  );
}

function locationValues(
  frameId: string,
  location: AutomaticLocation,
  source: "google_wifi" | "maxmind",
): unknown[] {
  return [
    frameId,
    source,
    location.label,
    location.city,
    location.subdivision,
    location.countryCode,
    location.latitude,
    location.longitude,
    location.timezone,
    location.accuracyRadiusKm,
  ];
}

async function expireDeviceEnrollments(
  client: Pick<PoolClient, "query">,
): Promise<void> {
  await client.query(
    `UPDATE naiskos.device_enrollments
        SET status='expired', resolved_at=now()
      WHERE status='pending' AND expires_at <= now()`,
  );
}
