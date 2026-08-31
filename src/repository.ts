import { randomBytes, randomUUID } from "node:crypto";
import { PoolClient } from "pg";

import { Database, oneOrNull, transaction } from "./db.js";
import { tokenHash } from "./security.js";
import { AutomaticLocation } from "./geo-location.js";
import {
  resolveFrameNotification,
  upsertFrameNotification,
} from "./notifications.js";

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
              pv.size_bytes::double precision AS "posterSizeBytes"
         FROM naiskos.frame_media fm
         JOIN naiskos.media m ON m.id = fm.media_id
         JOIN naiskos.media_variants v ON v.id = fm.variant_id
         LEFT JOIN naiskos.media_variants pv ON pv.id = fm.poster_variant_id
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
         JOIN naiskos.frame_media fm ON fm.variant_id = v.id OR fm.poster_variant_id = v.id
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
  ): Promise<string[]> {
    return transaction(this.database, async (client) => {
      const accepted: string[] = [];
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
