import { randomUUID } from 'node:crypto';
import { PoolClient } from 'pg';
import { Database, transaction } from './db.js';
import { TelegramApiError } from './telegram.js';

const titles: Record<string, string> = {
  recovering: 'Recuperación del visor en curso',
  'reboot-requested': 'Reinicio de emergencia solicitado',
  verifying: 'Equipo reiniciado; verificando Naiskos',
  recovered: 'Funcionamiento de Naiskos recuperado',
  failed: 'No se pudo confirmar la recuperación',
  limited: 'Recuperación automática limitada; requiere intervención',
};
export function validRecoveryEvent(event: Record<string, unknown>): boolean {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return typeof event.status === 'string' && Object.hasOwn(titles, event.status) &&
    Number.isSafeInteger(event.sequence) && Number(event.sequence) > 0 &&
    uuid.test(String(event.incidentId)) && uuid.test(String(event.bootId)) &&
    typeof event.reason === 'string' && event.reason.length <= 1000 &&
    typeof event.at === 'string' && Number.isFinite(Date.parse(event.at));
}
export function recoveryText(frameName: string, event: Record<string, unknown>): string {
  const time = new Intl.DateTimeFormat('es-PE', { timeZone: 'America/Lima',
    dateStyle: 'short', timeStyle: 'medium' }).format(new Date(String(event.at)));
  return `${event.status === 'recovered' ? '✅' : '⚠️'} ${frameName.slice(0, 150)}\n` +
    `${titles[String(event.status)]}\n${event.reason}\nOcurrió: ${time} (Lima)\nIncidente: ${event.incidentId}`;
}
// Same transaction as device_events: an ACK implies the delivery work is durable.
export async function queueRecoveryNotices(client: PoolClient, frameId: string, name: string,
  event: Record<string, unknown>, adminIds: string[]): Promise<void> {
  for (const chatId of new Set(adminIds)) await client.query(
    `INSERT INTO naiskos.jobs(id,kind,payload,status,available_at)
     VALUES($1,'telegram.recovery',$2,'pending',now())`,
    [randomUUID(), JSON.stringify({ chatId, frameId, incidentId: event.incidentId,
      eventId: event.id, sequence: event.sequence, text: recoveryText(name, event) })]);
}
export async function deliverRecoveryNotice(db: Database, workerId: string,
  telegram: { sendMessage(chatId: string, text: string): Promise<unknown> }): Promise<boolean> {
  const job = await transaction(db, async client => {
    const result = await client.query<{ id: string; attempts: number; payload: { chatId: string; text: string } }>(
      `WITH candidate AS (
         SELECT j.id FROM naiskos.jobs j WHERE j.kind='telegram.recovery'
           AND j.status='pending' AND j.available_at<=now()
           AND NOT EXISTS (SELECT 1 FROM naiskos.jobs older
             WHERE older.kind=j.kind AND older.status IN ('pending','running')
               AND older.payload->>'chatId'=j.payload->>'chatId'
               AND older.payload->>'frameId'=j.payload->>'frameId'
               AND (older.payload->>'sequence')::bigint<(j.payload->>'sequence')::bigint)
         ORDER BY j.created_at,j.id FOR UPDATE SKIP LOCKED LIMIT 1
       ) UPDATE naiskos.jobs j SET status='running',attempts=attempts+1,locked_at=now(),locked_by=$1
         FROM candidate c WHERE j.id=c.id RETURNING j.id,j.attempts,j.payload`, [workerId]);
    return result.rows[0];
  });
  if (!job) return false;
  try {
    await telegram.sendMessage(job.payload.chatId, job.payload.text);
    await db.query(`UPDATE naiskos.jobs SET status='succeeded',completed_at=now(),
      locked_at=NULL,locked_by=NULL,last_error=NULL WHERE id=$1 AND locked_by=$2`, [job.id, workerId]);
  } catch (error) {
    const delay = error instanceof TelegramApiError && error.retryAfterSeconds !== null
      ? Math.max(1, error.retryAfterSeconds) : Math.min(3600, 5 * 2 ** Math.min(job.attempts, 10));
    await db.query(`UPDATE naiskos.jobs SET status='pending',available_at=now()+make_interval(secs=>$3),
      locked_at=NULL,locked_by=NULL,last_error=$4 WHERE id=$1 AND locked_by=$2`,
    [job.id, workerId, delay, error instanceof Error ? error.message.slice(0, 1000) : 'Telegram no disponible']);
  }
  return true;
}
