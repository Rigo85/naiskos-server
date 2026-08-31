import { QueryResultRow } from "pg";

export type NotificationSeverity = "info" | "warning" | "error";

export interface FrameNotificationInput {
  frameId: string;
  kind: string;
  severity: NotificationSeverity;
  title: string;
  message: string;
  dedupeKey: string;
  details?: Record<string, unknown>;
}

interface Queryable {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

export async function upsertFrameNotification(
  database: Queryable,
  input: FrameNotificationInput,
): Promise<string> {
  const result = await database.query<{ id: string }>(
    `INSERT INTO naiskos.frame_notifications
       (frame_id, kind, severity, title, message, dedupe_key, details)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (frame_id, dedupe_key) DO UPDATE SET
       kind=EXCLUDED.kind, severity=EXCLUDED.severity, title=EXCLUDED.title,
       message=EXCLUDED.message, details=EXCLUDED.details, updated_at=now(),
       created_at=now(), read_at=NULL, dismissed_at=NULL, resolved_at=NULL
     RETURNING id`,
    [
      input.frameId,
      input.kind,
      input.severity,
      input.title.slice(0, 160),
      input.message.slice(0, 1_000),
      input.dedupeKey.slice(0, 200),
      JSON.stringify(input.details ?? {}),
    ],
  );
  return result.rows[0]!.id;
}

export async function resolveFrameNotification(
  database: Queryable,
  frameId: string,
  dedupeKey: string,
): Promise<boolean> {
  const result = await database.query(
    `UPDATE naiskos.frame_notifications
        SET resolved_at=COALESCE(resolved_at, now()),
            read_at=COALESCE(read_at, now()), updated_at=now()
      WHERE frame_id=$1 AND dedupe_key=$2 AND resolved_at IS NULL`,
    [frameId, dedupeKey],
  );
  return Boolean(result.rowCount);
}
