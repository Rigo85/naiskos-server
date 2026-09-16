import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { PostgresProvisioningStore, ProvisioningService } from '../src/admin/provisioning.js';
import { Repository } from '../src/repository.js';
const db = process.env.TEST_DATABASE_URL ? new Pool({ connectionString: process.env.TEST_DATABASE_URL }) : null;
afterAll(async () => db?.end());
describe.skipIf(!db)('orden de resultados de releases', () => {
  it('rechaza retrocesos, resultados tardíos y duplicados sin duplicar avisos', async () => {
    if (!db) throw new Error('TEST_DATABASE_URL requerido');
    const frame = await new ProvisioningService(new PostgresProvisioningStore(db), 'naiskosbot')
      .createFrame({ name: 'Runtime test' });
    const campaignId = randomUUID();
    const releaseId = `20260916-runtime-${randomUUID().slice(0, 8)}`;
    const repository = new Repository(db);
    try {
      await db.query(`INSERT INTO naiskos.software_releases
        (release_id,manifest,manifest_path,signature_path,archive_path,archive_size_bytes,archive_sha256)
        VALUES ($1,'{}','m','s','a',1,$2)`, [releaseId, 'a'.repeat(64)]);
      await db.query(`INSERT INTO naiskos.release_campaigns (id,release_id,status,expires_at)
        VALUES ($1,$2,'approved',now()+interval '1 hour')`, [campaignId, releaseId]);
      await db.query(`INSERT INTO naiskos.release_assignments (campaign_id,frame_id)
        VALUES ($1,$2)`, [campaignId, frame.frameId]);
      const event = (status: string) => ({ id: randomUUID(), type: 'software.release.status',
        at: new Date().toISOString(), campaignId, releaseId, status });
      const state = async () => (await db.query(`SELECT status FROM naiskos.release_assignments
        WHERE campaign_id=$1 AND frame_id=$2`, [campaignId, frame.frameId])).rows[0].status;
      await repository.applyDeviceEvents(frame.frameId, [event('observing'), event('awaiting_window')]);
      expect(await state()).toBe('observing');
      const done = event('installed');
      await repository.applyDeviceEvents(frame.frameId, [done, done, event('activating'), event('failed')]);
      expect(await state()).toBe('installed');
      const notices = await db.query(`SELECT count(*)::int AS n FROM naiskos.frame_notifications
        WHERE frame_id=$1 AND kind='software.release'`, [frame.frameId]);
      expect(notices.rows[0].n).toBe(1);
      const feedback=await db.query(`SELECT details->>'status' AS status FROM naiskos.release_feedback_events WHERE campaign_id=$1`,[campaignId]);
      expect(feedback.rows.map(row=>row.status)).toEqual(['completed']);
    } finally {
      await db.query("DELETE FROM naiskos.audit_log WHERE frame_id=$1 OR details->>'campaignId'=$2", [frame.frameId, campaignId]);
      await db.query('DELETE FROM naiskos.release_campaigns WHERE id=$1', [campaignId]);
      await db.query('DELETE FROM naiskos.software_releases WHERE release_id=$1', [releaseId]);
      await db.query('DELETE FROM naiskos.frames WHERE id=$1', [frame.frameId]);
    }
  });
});
