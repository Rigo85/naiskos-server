import { randomBytes, randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import {
  PostgresProvisioningStore,
  ProvisioningService,
} from "../src/admin/provisioning.js";
import { Repository } from "../src/repository.js";
import { tokenHash } from "../src/security.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const database = databaseUrl
  ? new Pool({ connectionString: databaseUrl, max: 2 })
  : null;

afterAll(async () => {
  await database?.end();
});

describe.skipIf(!database)("aprovisionamiento PostgreSQL", () => {
  it("crea, invita, rota y revoca conservando secretos sólo como hashes", async () => {
    if (!database) throw new Error("TEST_DATABASE_URL es obligatorio");

    const service = new ProvisioningService(
      new PostgresProvisioningStore(database),
      "naiskosbot",
    );
    const frame = await service.createFrame({
      name: "Marco de integración",
      width: 1280,
      height: 800,
    });

    try {
      const storedToken = await database.query<{ tokenHash: Buffer }>(
        `SELECT token_hash AS "tokenHash"
           FROM naiskos.agent_tokens
          WHERE id=$1 AND frame_id=$2`,
        [frame.tokenId, frame.frameId],
      );
      expect(storedToken.rows[0]?.tokenHash).toEqual(tokenHash(frame.agentToken));

      const invitation = await service.createInvitation({
        frameId: frame.frameId,
        expiresInHours: 24,
      });
      const storedInvitation = await database.query<{ codeHash: Buffer }>(
        `SELECT code_hash AS "codeHash"
           FROM naiskos.frame_invitations
          WHERE id=$1 AND frame_id=$2`,
        [invitation.invitationId, frame.frameId],
      );
      expect(storedInvitation.rows[0]?.codeHash).toEqual(
        tokenHash(invitation.code),
      );

      const rotated = await service.rotateToken({ frameId: frame.frameId });
      expect(rotated.revokedCount).toBe(1);
      await service.revokeToken({
        frameId: frame.frameId,
        tokenId: rotated.tokenId,
      });

      const summary = (await service.listFrames()).find(
        (candidate) => candidate.id === frame.frameId,
      );
      expect(summary?.activeTokenCount).toBe(0);

      const audit = await database.query<{ action: string }>(
        `SELECT action FROM naiskos.audit_log
          WHERE frame_id=$1 ORDER BY id`,
        [frame.frameId],
      );
      expect(audit.rows.map((row) => row.action)).toEqual([
        "frame.created",
        "frame.invitation.created",
        "frame.token.rotated",
        "frame.token.revoked",
      ]);
    } finally {
      await database.query("DELETE FROM naiskos.audit_log WHERE frame_id=$1", [
        frame.frameId,
      ]);
      await database.query("DELETE FROM naiskos.frames WHERE id=$1", [
        frame.frameId,
      ]);
    }
  });

  it("reserva una invitación y vincula el marco al aprobar al usuario", async () => {
    if (!database) throw new Error("TEST_DATABASE_URL es obligatorio");

    const provisioning = new ProvisioningService(
      new PostgresProvisioningStore(database),
      "naiskosbot",
    );
    const repository = new Repository(database);
    const frame = await provisioning.createFrame({
      name: "Marco para autorización",
    });
    const invitation = await provisioning.createInvitation({
      frameId: frame.frameId,
    });
    const user = await repository.upsertPendingTelegramUser("10001", "Rigo");

    try {
      const claimed = await repository.claimInvitation(invitation.code, user.id);
      expect(claimed?.frameId).toBe(frame.frameId);

      const approval = await repository.approveTelegramUser("10001", "99999");
      expect(approval).toEqual({
        approved: true,
        grantedFrames: [
          { frameId: frame.frameId, frameName: "Marco para autorización" },
        ],
      });
      expect(await repository.accessibleFrames(user.id)).toEqual([
        { id: frame.frameId, name: "Marco para autorización" },
      ]);
      expect(
        await repository.consumeInvitation(invitation.code, user.id),
      ).toBeNull();

      const persisted = await database.query<{
        used: boolean;
        claimedBy: string;
        membershipStatus: string;
      }>(
        `SELECT i.used_at IS NOT NULL AS used,
                i.claimed_by_telegram_user_id AS "claimedBy",
                m.status AS "membershipStatus"
           FROM naiskos.frame_invitations i
           JOIN naiskos.frame_memberships m
             ON m.frame_id=i.frame_id AND m.telegram_user_id=$2
          WHERE i.id=$1`,
        [invitation.invitationId, user.id],
      );
      expect(persisted.rows[0]).toEqual({
        used: true,
        claimedBy: user.id,
        membershipStatus: "approved",
      });

      const audit = await database.query<{ action: string }>(
        `SELECT action FROM naiskos.audit_log
          WHERE frame_id=$1 OR details->>'telegramId'='10001'
          ORDER BY id`,
        [frame.frameId],
      );
      expect(audit.rows.map((row) => row.action)).toContain(
        "frame.invitation.claimed",
      );
      expect(audit.rows.map((row) => row.action)).toContain(
        "telegram.user.approved",
      );
      expect(audit.rows.map((row) => row.action)).toContain(
        "frame.invitation.consumed",
      );
    } finally {
      await database.query(
        `DELETE FROM naiskos.audit_log
          WHERE frame_id=$1 OR actor_telegram_user_id=$2
             OR details->>'telegramId'='10001'`,
        [frame.frameId, user.id],
      );
      await database.query("DELETE FROM naiskos.frames WHERE id=$1", [
        frame.frameId,
      ]);
      await database.query("DELETE FROM naiskos.telegram_users WHERE id=$1", [
        user.id,
      ]);
    }
  });

  it("aprueba un dispositivo sin enviar su serie ni su token en texto plano", async () => {
    if (!database) throw new Error("TEST_DATABASE_URL es obligatorio");

    const repository = new Repository(database);
    const requestId = randomUUID();
    const hardwareFingerprint = randomBytes(32);
    const agentToken = randomBytes(32).toString("base64url");
    const claimCode = randomBytes(18).toString("base64url");
    let frameId: string | null = null;

    try {
      expect(
        await repository.createDeviceEnrollment({
          requestId,
          hardwareFingerprint,
          tokenHash: tokenHash(agentToken),
          claimCodeHash: tokenHash(claimCode),
          deviceModel: "Raspberry Pi 4 Model B Rev 1.5",
          suggestedName: "Naiskos 5D5CF4",
          width: 1280,
          height: 800,
        }),
      ).toEqual({ changed: true, status: "pending" });

      expect(await repository.getDeviceEnrollment(requestId, "token-incorrecto")).toBeNull();
      expect((await repository.getDeviceEnrollment(requestId, agentToken))?.status).toBe(
        "pending",
      );
      expect(
        (await repository.findDeviceEnrollmentByClaimCode(claimCode))?.requestId,
      ).toBe(requestId);

      const approval = await repository.approveDeviceEnrollment(requestId, "99999");
      expect(approval.changed).toBe(true);
      expect(approval.status).toBe("approved");
      frameId = approval.frameId ?? null;
      expect(frameId).not.toBeNull();
      expect((await repository.authenticateFrame(agentToken))?.id).toBe(frameId);

      const stored = await database.query<{
        hardwareFingerprint: Buffer;
        tokenHash: Buffer;
        rawHardwareMatches: boolean;
      }>(
        `SELECT e.hardware_fingerprint AS "hardwareFingerprint",
                e.token_hash AS "tokenHash",
                false AS "rawHardwareMatches"
           FROM naiskos.device_enrollments e WHERE e.id=$1`,
        [requestId],
      );
      expect(stored.rows[0]?.hardwareFingerprint).toEqual(hardwareFingerprint);
      expect(stored.rows[0]?.tokenHash).toEqual(tokenHash(agentToken));

      const duplicate = await repository.createDeviceEnrollment({
        requestId: randomUUID(),
        hardwareFingerprint,
        tokenHash: randomBytes(32),
        claimCodeHash: randomBytes(32),
        deviceModel: "Raspberry Pi 4 Model B Rev 1.5",
        suggestedName: "Duplicado",
        width: 1280,
        height: 800,
      });
      expect(duplicate.status).toBe("already_enrolled");
    } finally {
      await database.query(
        `DELETE FROM naiskos.audit_log
          WHERE frame_id=$1 OR details->>'requestId'=$2`,
        [frameId, requestId],
      );
      await database.query("DELETE FROM naiskos.device_enrollments WHERE id=$1", [
        requestId,
      ]);
      if (frameId) {
        await database.query("DELETE FROM naiskos.frames WHERE id=$1", [frameId]);
      }
    }
  });

  it("aplica rechazo, reintento, bloqueo, desbloqueo y revocación sin restaurar accesos", async () => {
    if (!database) throw new Error("TEST_DATABASE_URL es obligatorio");

    const repository = new Repository(database);
    const provisioning = new ProvisioningService(
      new PostgresProvisioningStore(database),
      "naiskosbot",
    );
    const frame = await provisioning.createFrame({ name: "Marco de ciclo" });
    const invitation = await provisioning.createInvitation({ frameId: frame.frameId });
    let user = await repository.upsertPendingTelegramUser("20002", "Usuario ciclo");

    try {
      expect(await repository.rejectTelegramUser("20002", "99999")).toBe(true);
      expect((await repository.findTelegramUser("20002"))?.status).toBe("rejected");
      user = await repository.upsertPendingTelegramUser("20002", "Usuario ciclo");
      expect(user.status).toBe("pending");
      expect((await repository.approveTelegramUser("20002", "99999")).approved).toBe(
        true,
      );
      expect(await repository.consumeInvitation(invitation.code, user.id)).not.toBeNull();
      expect(await repository.accessibleFrames(user.id)).toHaveLength(1);

      expect(await repository.blockTelegramUser("20002", "99999")).toBe(true);
      expect((await repository.findTelegramUser("20002"))?.status).toBe("blocked");
      expect(await repository.accessibleFrames(user.id)).toEqual([]);
      expect(await repository.unblockTelegramUser("20002", "99999")).toBe(true);
      expect((await repository.findTelegramUser("20002"))?.status).toBe("pending");
      expect((await repository.approveTelegramUser("20002", "99999")).approved).toBe(
        true,
      );
      expect(await repository.accessibleFrames(user.id)).toEqual([]);

      expect(await repository.revokeTelegramUser("20002", "99999")).toBe(true);
      expect((await repository.findTelegramUser("20002"))?.status).toBe("revoked");
      expect(await repository.reactivateTelegramUser("20002", "99999")).toBe(true);
      expect((await repository.findTelegramUser("20002"))?.status).toBe("pending");
    } finally {
      await database.query(
        `DELETE FROM naiskos.audit_log
          WHERE frame_id=$1 OR actor_telegram_user_id=$2
             OR details->>'telegramId'='20002'`,
        [frame.frameId, user.id],
      );
      await database.query("DELETE FROM naiskos.frames WHERE id=$1", [frame.frameId]);
      await database.query("DELETE FROM naiskos.telegram_users WHERE id=$1", [user.id]);
    }
  });
});
