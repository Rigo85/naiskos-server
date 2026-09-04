import { randomUUID } from "node:crypto";

import { PoolClient } from "pg";

import { Database, transaction } from "./db.js";
import { TelegramApiError } from "./telegram.js";

export type TelegramMediaNoticeCategory =
  | "media.received"
  | "media.ready"
  | "media.duplicate"
  | "media.capacity"
  | "media.failed"
  | "media.rejected"
  | "admin.media.capacity"
  | "admin.media.failed"
  | "admin.media.rejected";

interface TelegramMediaNoticePayload {
  chatId: string;
  category: TelegramMediaNoticeCategory;
}

export interface ClaimedTelegramMediaNoticeBatch {
  ids: string[];
  chatId: string;
  category: TelegramMediaNoticeCategory;
  count: number;
  attempts: number;
}

type Queryable = Pick<Database | PoolClient, "query">;

const DELIVERY_DELAYS_SECONDS: Record<TelegramMediaNoticeCategory, number> = {
  "media.received": 10,
  "media.ready": 30,
  "media.duplicate": 30,
  "media.capacity": 10,
  "media.failed": 10,
  "media.rejected": 10,
  "admin.media.capacity": 10,
  "admin.media.failed": 10,
  "admin.media.rejected": 10,
};

export async function queueTelegramMediaNotice(
  database: Queryable,
  chatId: string,
  category: TelegramMediaNoticeCategory,
): Promise<string> {
  const id = randomUUID();
  await database.query(
    `INSERT INTO naiskos.jobs
       (id, kind, payload, status, available_at)
     VALUES ($1, 'telegram.notify', $2, 'pending',
             now() + make_interval(secs => $3))`,
    [
      id,
      JSON.stringify({ chatId, category } satisfies TelegramMediaNoticePayload),
      DELIVERY_DELAYS_SECONDS[category],
    ],
  );
  return id;
}

export async function claimTelegramMediaNoticeBatch(
  database: Database,
  workerId: string,
): Promise<ClaimedTelegramMediaNoticeBatch | null> {
  return transaction(database, async (client) => {
    const seed = await client.query<{
      chatId: string;
      category: TelegramMediaNoticeCategory;
    }>(
      `SELECT payload->>'chatId' AS "chatId",
              payload->>'category' AS category
         FROM naiskos.jobs
        WHERE kind='telegram.notify' AND status='pending'
          AND available_at <= now()
        ORDER BY available_at, created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1`,
    );
    const selected = seed.rows[0];
    if (!selected) return null;

    const claimed = await client.query<{
      id: string;
      attempts: number;
    }>(
      `WITH candidates AS (
         SELECT id
           FROM naiskos.jobs
          WHERE kind='telegram.notify' AND status='pending'
            AND available_at <= now()
            AND payload->>'chatId'=$1
            AND payload->>'category'=$2
          ORDER BY created_at
          FOR UPDATE SKIP LOCKED
          LIMIT 2000
       )
       UPDATE naiskos.jobs j
          SET status='running', attempts=attempts+1,
              locked_at=now(), locked_by=$3
         FROM candidates c
        WHERE j.id=c.id
       RETURNING j.id, j.attempts`,
      [selected.chatId, selected.category, workerId],
    );
    if (!claimed.rowCount) return null;
    return {
      ids: claimed.rows.map((row) => row.id),
      chatId: selected.chatId,
      category: selected.category,
      count: claimed.rows.length,
      attempts: Math.max(...claimed.rows.map((row) => row.attempts)),
    };
  });
}

export async function completeTelegramMediaNoticeBatch(
  database: Database,
  batch: ClaimedTelegramMediaNoticeBatch,
): Promise<void> {
  await database.query(
    `UPDATE naiskos.jobs
        SET status='succeeded', completed_at=now(),
            locked_at=NULL, locked_by=NULL, last_error=NULL
      WHERE id=ANY($1::uuid[])`,
    [batch.ids],
  );
}

export async function retryTelegramMediaNoticeBatch(
  database: Database,
  batch: ClaimedTelegramMediaNoticeBatch,
  error: unknown,
): Promise<number> {
  const detail = error instanceof Error ? error.message : String(error);
  const retryAfter =
    error instanceof TelegramApiError && error.retryAfterSeconds !== null
      ? error.retryAfterSeconds
      : Math.min(3600, 2 ** Math.min(batch.attempts, 10) * 5);
  await transaction(database, async (client) => {
    await client.query(
      `UPDATE naiskos.jobs
          SET status='pending',
              available_at=now() + make_interval(secs => $2),
              locked_at=NULL, locked_by=NULL, last_error=$3
        WHERE id=ANY($1::uuid[])`,
      [batch.ids, retryAfter, detail.slice(0, 2_000)],
    );
    await client.query(
      `UPDATE naiskos.jobs
          SET available_at=GREATEST(
                available_at,
                now() + make_interval(secs => $2)
              )
        WHERE kind='telegram.notify' AND status='pending'
          AND payload->>'chatId'=$1`,
      [batch.chatId, retryAfter],
    );
  });
  return retryAfter;
}

export function formatTelegramMediaNotice(
  category: TelegramMediaNoticeCategory,
  count: number,
): string {
  const plural = count === 1 ? "" : "s";
  switch (category) {
    case "media.received":
      return count === 1
        ? "Contenido recibido y puesto en cola. Te avisaré cuando esté listo."
        : `${count} contenidos recibidos y puestos en cola. Te avisaré cuando estén listos.`;
    case "media.ready":
      return count === 1
        ? "El contenido ya está listo y será sincronizado por el marco."
        : `${count} contenidos ya están listos y serán sincronizados por el marco.`;
    case "media.duplicate":
      return count === 1
        ? "Ese contenido ya estaba disponible en el marco; no se creó una copia."
        : `${count} contenidos ya estaban disponibles en el marco; no se crearon copias.`;
    case "media.capacity":
      return `${count === 1 ? "El contenido fue procesado" : `${count} contenidos fueron procesados`}, pero al menos un marco alcanzó el 90 % de almacenamiento. ${count === 1 ? "Se conservará pendiente" : "Se conservarán pendientes"} hasta liberar espacio.`;
    case "media.failed":
      return count === 1
        ? "No se pudo procesar un contenido después de varios intentos. Comprueba que no esté dañado y vuelve a enviarlo."
        : `No se pudieron procesar ${count} contenidos después de varios intentos. Comprueba los archivos y vuelve a enviarlos.`;
    case "media.rejected":
      return count === 1
        ? "Un contenido fue rechazado porque no cumple los límites de Naiskos."
        : `${count} contenidos fueron rechazados porque no cumplen los límites de Naiskos.`;
    case "admin.media.capacity":
      return `Aviso operativo de Naiskos: ${count} contenido${plural} ${count === 1 ? "quedó" : "quedaron"} pendiente${plural} por capacidad.`;
    case "admin.media.failed":
      return `Aviso operativo de Naiskos: falló definitivamente el procesamiento de ${count} contenido${plural}.`;
    case "admin.media.rejected":
      return `Aviso operativo de Naiskos: ${count} contenido${plural} fue${count === 1 ? "" : "ron"} rechazado${plural}.`;
  }
}
