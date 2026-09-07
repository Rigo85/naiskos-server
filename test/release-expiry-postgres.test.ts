import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { PostgresProvisioningStore, ProvisioningService } from "../src/admin/provisioning.js";
import { Repository } from "../src/repository.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const database = databaseUrl ? new Pool({ connectionString: databaseUrl, max: 2 }) : null;

afterAll(async () => database?.end());

describe.skipIf(!database)("vencimiento de campañas Naiskos en PostgreSQL", () => {
  it("deja de entregar la release y cancela la campaña vencida con auditoría", async () => {
    if (!database) throw new Error("TEST_DATABASE_URL es obligatorio");
    const provisioning = new ProvisioningService(
      new PostgresProvisioningStore(database),
      "naiskosbot",
    );
    const repository = new Repository(database);
    const frame = await provisioning.createFrame({ name: "Marco deadline" });
    const campaignId = randomUUID();
    const releaseId = `20260907-expiry-${randomUUID().slice(0, 8)}`;

    try {
      await database.query(
        `INSERT INTO naiskos.software_releases
           (release_id,manifest,manifest_path,signature_path,archive_path,
            archive_size_bytes,archive_sha256)
         VALUES ($1,'{}','manifest','signature','archive',1,$2)`,
        [releaseId, "a".repeat(64)],
      );
      await database.query(
        `INSERT INTO naiskos.release_campaigns
           (id,release_id,status,expires_at)
         VALUES ($1,$2,'approved',now()+interval '1 hour')`,
        [campaignId, releaseId],
      );
      await database.query(
        `INSERT INTO naiskos.release_assignments (campaign_id,frame_id)
         VALUES ($1,$2)`,
        [campaignId, frame.frameId],
      );

      expect(await repository.getDesiredSoftware(frame.frameId)).toMatchObject({
        campaignId,
        releaseId,
      });

      await database.query(
        `UPDATE naiskos.release_campaigns
            SET created_at=now()-interval '2 hours',
                expires_at=now()-interval '1 hour'
          WHERE id=$1`,
        [campaignId],
      );
      expect(await repository.expireReleaseCampaigns()).toEqual([
        { campaignId, releaseId },
      ]);
      expect(await repository.getDesiredSoftware(frame.frameId)).toBeNull();

      const state = await database.query<{ status: string; audits: number }>(
        `SELECT c.status,
                count(l.id) FILTER (WHERE l.action='release.campaign.expired')::integer AS audits
           FROM naiskos.release_campaigns c
           LEFT JOIN naiskos.audit_log l ON l.details->>'campaignId'=c.id::text
          WHERE c.id=$1 GROUP BY c.id`,
        [campaignId],
      );
      expect(state.rows[0]).toEqual({ status: "cancelled", audits: 1 });
    } finally {
      await database.query("DELETE FROM naiskos.audit_log WHERE details->>'campaignId'=$1", [campaignId]);
      await database.query("DELETE FROM naiskos.release_campaigns WHERE id=$1", [campaignId]);
      await database.query("DELETE FROM naiskos.software_releases WHERE release_id=$1", [releaseId]);
      await database.query("DELETE FROM naiskos.frames WHERE id=$1", [frame.frameId]);
    }
  });
});
