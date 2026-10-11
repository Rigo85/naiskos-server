import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { Repository } from '../src/repository.js';
import { PostgresProvisioningStore, ProvisioningService } from '../src/admin/provisioning.js';
import { deliverRecoveryNotice } from '../src/recovery-notifications.js';
import { TelegramApiError } from '../src/telegram.js';
const db = process.env.TEST_DATABASE_URL ? new Pool({ connectionString: process.env.TEST_DATABASE_URL }) : null;
afterAll(async () => db?.end());
describe.skipIf(!db)('entrega persistente de emergencias', () => {
  it('ACK transaccional, duplicados, orden, reintentos 429 y varios marcos/destinatarios', async () => {
    if (!db) throw Error('db required');
    const repo = new Repository(db);
    const frame = await new ProvisioningService(new PostgresProvisioningStore(db), 'naiskosbot').createFrame({ name: 'Recovery test' });
    const other = await new ProvisioningService(new PostgresProvisioningStore(db), 'naiskosbot').createFrame({ name: 'Other frame' });
    const incidentId = randomUUID(), bootId = randomUUID();
    const event = (sequence: number, status: string) => ({ id: randomUUID(), type: 'system.recovery.status',
      at: new Date().toISOString(), incidentId, bootId, sequence, status, reason: 'Test' });
    const a = event(1, 'reboot-requested'), b = event(2, 'verifying'), c = event(3, 'recovered');
    try {
      await repo.applyDeviceEvents(frame.frameId, [a, b, c, a], [], ['99', '99']);
      expect((await db.query(`SELECT id FROM naiskos.jobs WHERE kind='telegram.recovery' AND payload->>'frameId'=$1`, [frame.frameId])).rowCount).toBe(3);
      await deliverRecoveryNotice(db, 'test-worker', { sendMessage: async () => { throw new TelegramApiError('429', 120); } });
      const pending = await db.query(`SELECT attempts,status,available_at>now() AS delayed FROM naiskos.jobs WHERE payload->>'eventId'=$1`, [a.id]);
      expect(pending.rows[0]).toMatchObject({ attempts: 1, status: 'pending', delayed: true });
      const messages: string[] = [];
      const transport = { sendMessage: async (_: string, text: string) => { messages.push(text); } };
      expect(await deliverRecoveryNotice(db, 'test-worker', transport)).toBe(false); // Later states wait.
      await repo.applyDeviceEvents(other.frameId, [event(1, 'recovering')], [], ['100']);
      expect(await deliverRecoveryNotice(db, 'test-worker', transport)).toBe(true); // Other frame unaffected.
      for (let retry = 0; retry < 3; retry++) {
        await db.query(`UPDATE naiskos.jobs SET available_at=now() WHERE payload->>'eventId'=$1`, [a.id]);
        await deliverRecoveryNotice(db, 'test-worker', { sendMessage: async () => { throw Error('offline'); } });
      }
      await db.query(`UPDATE naiskos.jobs SET available_at=now() WHERE payload->>'frameId'=$1`, [frame.frameId]);
      for (let n = 0; n < 3; n++) await deliverRecoveryNotice(db, 'test-worker', transport);
      expect(messages.slice(1).map(text => text.split('\n')[1])).toEqual([
        'Reinicio de emergencia solicitado', 'Equipo reiniciado; verificando Naiskos', 'Funcionamiento de Naiskos recuperado']);
      await repo.applyDeviceEvents(frame.frameId, [a, b, c], [], ['99']);
      expect(await deliverRecoveryNotice(db, 'test-worker', transport)).toBe(false);
    } finally {
      await db.query(`DELETE FROM naiskos.jobs WHERE kind='telegram.recovery' AND payload->>'frameId'=ANY($1::text[])`, [[frame.frameId, other.frameId]]);
      await db.query('DELETE FROM naiskos.device_events WHERE frame_id=ANY($1::uuid[])', [[frame.frameId, other.frameId]]);
      await db.query('DELETE FROM naiskos.frames WHERE id=ANY($1::uuid[])', [[frame.frameId, other.frameId]]);
    }
  });
});
