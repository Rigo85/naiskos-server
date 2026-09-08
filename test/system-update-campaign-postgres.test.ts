import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { PostgresProvisioningStore, ProvisioningService } from "../src/admin/provisioning.js";
import { Repository } from "../src/repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const database = databaseUrl ? new Pool({ connectionString: databaseUrl, max: 2 }) : null;

afterAll(async () => database?.end());

describe.skipIf(!database)("campaña de actualización del SO en PostgreSQL", () => {
  it("crea el piloto, entrega permiso y completa después de observar salud", async () => {
    if (!database) throw new Error("TEST_DATABASE_URL es obligatorio");
    const provisioning = new ProvisioningService(
      new PostgresProvisioningStore(database),
      "naiskosbot",
    );
    const repository = new Repository(database);
    const frame = await provisioning.createFrame({
      name: "Piloto C3.5",
      width: 1280,
      height: 800,
    });
    try {
      const campaignId = await repository.ensureMonthlySystemUpdateCampaign(
        new Date("2020-02-02T06:00:00.000Z"),
      );
      expect(campaignId).toMatch(/^[0-9a-f-]{36}$/);
      await database.query(
        `UPDATE naiskos.system_update_campaigns
            SET scheduled_at=now()-interval '1 minute',expires_at=now()+interval '1 day'
          WHERE id=$1`,
        [campaignId],
      );
      const permit = await repository.getSystemUpdatePermit(frame.frameId);
      expect(permit).toMatchObject({
        campaignId,
        attemptId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        kind: "general",
        period: "2020-02",
        expiresAt: expect.any(Date),
      });

      await repository.applyDeviceEvents(frame.frameId, [{
        id: randomUUID(),
        type: "system.maintenance.status",
        at: new Date().toISOString(),
        mode: "general",
        status: "running",
        packagesChanged: 0,
        packagesPending: 4,
        rebootRequired: false,
        campaignId,
        attemptId: randomUUID(),
      }]);
      const staleAttempt = await database.query<{ status: string }>(
        `SELECT status FROM naiskos.system_update_assignments
          WHERE campaign_id=$1 AND frame_id=$2`,
        [campaignId, frame.frameId],
      );
      expect(staleAttempt.rows[0]?.status).toBe("assigned");

      await repository.applyDeviceEvents(frame.frameId, [{
        id: randomUUID(),
        type: "system.maintenance.status",
        at: new Date().toISOString(),
        mode: "general",
        status: "running",
        packagesChanged: 0,
        packagesPending: 4,
        rebootRequired: false,
        campaignId,
        attemptId: permit!.attemptId,
      }]);
      await repository.applyDeviceEvents(frame.frameId, [{
        id: randomUUID(),
        type: "system.maintenance.status",
        at: new Date().toISOString(),
        mode: "general",
        status: "reboot_pending",
        packagesChanged: 4,
        packagesPending: 0,
        rebootRequired: true,
        campaignId,
        attemptId: permit!.attemptId,
      }]);
      await repository.applyDeviceEvents(frame.frameId, [{
        id: randomUUID(),
        type: "system.maintenance.status",
        at: new Date().toISOString(),
        mode: "general",
        status: "verifying",
        packagesChanged: 4,
        packagesPending: 0,
        rebootRequired: true,
        campaignId,
        attemptId: permit!.attemptId,
      }]);
      await repository.applyDeviceEvents(frame.frameId, [{
        id: randomUUID(),
        type: "system.maintenance.status",
        at: new Date().toISOString(),
        mode: "general",
        status: "succeeded",
        packagesChanged: 4,
        packagesPending: 0,
        rebootRequired: true,
        campaignId,
        attemptId: permit!.attemptId,
      }]);
      await repository.recordHeartbeat(frame.frameId, {
        schemaVersion: 1,
        kind: "heartbeat",
        frameId: frame.frameId,
        observedAt: new Date().toISOString(),
        uptimeSeconds: 60,
        agentState: "syncing",
        installedManifestVersion: 0,
        lastSyncAt: new Date().toISOString(),
        lastErrorCode: null,
      });
      await database.query(
        `UPDATE naiskos.system_update_campaigns SET observe_minutes=1 WHERE id=$1`,
        [campaignId],
      );
      await database.query(
        `UPDATE naiskos.system_update_assignments SET updated_at=now()-interval '2 minutes' WHERE campaign_id=$1`,
        [campaignId],
      );
      expect(await repository.advanceSystemUpdateCampaigns()).toEqual([
        `completed:${campaignId}`,
      ]);
      expect((await repository.listSystemUpdateCampaigns())[0]).toMatchObject({
        id: campaignId,
        status: "completed",
        installed: 1,
        failed: 0,
      });
    } finally {
      await database.query("DELETE FROM naiskos.audit_log WHERE frame_id=$1 OR action LIKE 'system.update.campaign.%'", [frame.frameId]);
      await database.query("DELETE FROM naiskos.system_update_campaigns WHERE period='2020-02'");
      await database.query("DELETE FROM naiskos.frames WHERE id=$1", [frame.frameId]);
    }
  });
});
