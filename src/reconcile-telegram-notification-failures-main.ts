import { loadConfig } from "./config.js";
import { createDatabase } from "./db.js";

interface Candidate {
  jobId: string;
  mediaId: string;
  mediaKind: "photo" | "video";
  frameCount: number;
}

const apply = process.argv.slice(2).includes("--apply");
const unknownArguments = process.argv
  .slice(2)
  .filter((argument) => argument !== "--apply");
if (unknownArguments.length) {
  throw new Error(`Argumentos desconocidos: ${unknownArguments.join(", ")}`);
}

const database = createDatabase(loadConfig());
const client = await database.connect();

try {
  await client.query("BEGIN");
  const candidates = await client.query<Candidate>(
    `SELECT j.id AS "jobId", m.id AS "mediaId", m.kind AS "mediaKind",
            jsonb_array_length(j.payload->'frameIds') AS "frameCount"
       FROM naiskos.jobs j
       JOIN naiskos.media m
         ON m.source='telegram'
        AND m.source_unique_id=j.payload->>'telegramFileUniqueId'
      WHERE j.kind='telegram.ingest'
        AND j.status='failed'
        AND j.last_error LIKE 'Too Many Requests:%'
        AND m.status='ready'
        AND EXISTS (
          SELECT 1 FROM naiskos.media_variants v
           WHERE v.media_id=m.id AND v.purpose='original'
             AND v.rotation_degrees=0
        )
        AND EXISTS (
          SELECT 1 FROM naiskos.media_variants v
           WHERE v.media_id=m.id AND v.purpose='display'
             AND v.rotation_degrees=0
        )
        AND EXISTS (
          SELECT 1 FROM naiskos.media_variants v
           WHERE v.media_id=m.id AND v.purpose='thumbnail'
             AND v.rotation_degrees=0
        )
        AND (
          m.kind='photo' OR EXISTS (
            SELECT 1 FROM naiskos.media_variants v
             WHERE v.media_id=m.id AND v.purpose='poster'
               AND v.rotation_degrees=0
          )
        )
        AND NOT EXISTS (
          SELECT 1
            FROM jsonb_array_elements_text(j.payload->'frameIds') expected(frame_id)
            LEFT JOIN naiskos.frame_media fm
              ON fm.frame_id=expected.frame_id::uuid
             AND fm.media_id=m.id
             AND fm.deleted_at IS NULL
           WHERE fm.media_id IS NULL
        )
      ORDER BY j.created_at
      FOR UPDATE OF j`,
  );

  const ids = candidates.rows.map((candidate) => candidate.jobId);
  const notificationCount = ids.length
    ? Number(
        (
          await client.query<{ count: string }>(
            `SELECT count(*)::text AS count
               FROM naiskos.frame_notifications
              WHERE kind='media.processing.failed'
                AND dedupe_key=ANY(
                  SELECT 'ingest-failed:' || unnest($1::uuid[])::text
                )
                AND dismissed_at IS NULL`,
            [ids],
          )
        ).rows[0]?.count ?? 0,
      )
    : 0;

  if (!apply || ids.length === 0) {
    await client.query("ROLLBACK");
    console.log(
      JSON.stringify({
        mode: apply ? "apply" : "dry-run",
        candidates: candidates.rowCount ?? 0,
        visibleNotifications: notificationCount,
        byKind: Object.fromEntries(
          ["photo", "video"].map((kind) => [
            kind,
            candidates.rows.filter((candidate) => candidate.mediaKind === kind)
              .length,
          ]),
        ),
      }),
    );
    process.exitCode = 0;
  } else {
    await client.query(
      `INSERT INTO naiskos.audit_log (frame_id, action, details)
       SELECT n.frame_id, 'media.processing.failure_reconciled',
              jsonb_build_object(
                'jobId', replace(n.dedupe_key, 'ingest-failed:', ''),
                'reason', 'telegram-notification-rate-limit'
              )
         FROM naiskos.frame_notifications n
        WHERE n.kind='media.processing.failed'
          AND n.dedupe_key=ANY(
            SELECT 'ingest-failed:' || unnest($1::uuid[])::text
          )`,
      [ids],
    );
    await client.query(
      `UPDATE naiskos.jobs
          SET status='succeeded', last_error=NULL,
              completed_at=COALESCE(completed_at, now()),
              locked_at=NULL, locked_by=NULL
        WHERE id=ANY($1::uuid[])`,
      [ids],
    );
    const notifications = await client.query(
      `UPDATE naiskos.frame_notifications
          SET read_at=COALESCE(read_at, now()),
              resolved_at=COALESCE(resolved_at, now()),
              dismissed_at=COALESCE(dismissed_at, now()),
              updated_at=now()
        WHERE kind='media.processing.failed'
          AND dedupe_key=ANY(
            SELECT 'ingest-failed:' || unnest($1::uuid[])::text
          )
      RETURNING id`,
      [ids],
    );
    await client.query("COMMIT");
    console.log(
      JSON.stringify({
        mode: "apply",
        reconciledJobs: ids.length,
        reconciledNotifications: notifications.rowCount ?? 0,
      }),
    );
  }
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await database.end();
}
