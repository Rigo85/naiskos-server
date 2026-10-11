import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
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
    vi.stubEnv('DATABASE_URL', process.env.TEST_DATABASE_URL!);
    const config = loadConfig(); config.telegramAdminIds = new Set(['99']);
    vi.unstubAllEnvs();
    const app = await buildApp(config, db);
    try {
      const request = { method: 'POST' as const, url: `/api/v1/frames/${frame.frameId}/recovery-events`,
        headers: { authorization: `Bearer ${frame.agentToken}` }, payload: { events: [a, b, c, a] } };
      expect((await app.inject({ ...request, headers: {} })).statusCode).toBe(401);
      expect((await app.inject({ ...request, url: `/api/v1/frames/${other.frameId}/recovery-events` })).statusCode).toBe(401);
      expect((await app.inject({ ...request, payload: { events: [{ ...a, type: 'settings.updated' }] } })).statusCode).toBe(400);
      const response = await app.inject(request);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ schemaVersion: 1, accepted: [a.id, b.id, c.id, a.id] });
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
      await app.close();
      await db.query(`DELETE FROM naiskos.jobs WHERE kind='telegram.recovery' AND payload->>'frameId'=ANY($1::text[])`, [[frame.frameId, other.frameId]]);
      await db.query('DELETE FROM naiskos.device_events WHERE frame_id=ANY($1::uuid[])', [[frame.frameId, other.frameId]]);
      await db.query('DELETE FROM naiskos.frames WHERE id=ANY($1::uuid[])', [[frame.frameId, other.frameId]]);
    }
  });
});
