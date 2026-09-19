import { realpath } from "node:fs/promises";
import path from "node:path";
import { Database, transaction } from "./db.js";
import { extractBandColors } from "./band-colors.js";

/** Bounded, sequential, resumable enrichment. Never writes/re-encodes a media file. */
export async function backfillBandColors(database: Database, storageRoot: string,
  frameId: string, apply = false, afterId = "00000000-0000-0000-0000-000000000000") {
  const root = await realpath(storageRoot);
  const { rows } = await database.query<{ id: string; storagePath: string; sha256: Buffer }>(
    `SELECT DISTINCT v.id, v.storage_path AS "storagePath", v.sha256
       FROM naiskos.frame_media fm JOIN naiskos.media m ON m.id=fm.media_id
       JOIN naiskos.media_variants v ON v.id=CASE WHEN m.kind='video' THEN fm.poster_variant_id ELSE fm.variant_id END
      WHERE fm.frame_id=$1 AND fm.deleted_at IS NULL AND fm.sync_status='active'
        AND v.band_colors IS NULL AND v.id>$2 ORDER BY v.id LIMIT 200`, [frameId, afterId]);
  const measured: Array<{ id: string; sha256: Buffer; colors: [string, string] }> = [];
  for (const row of rows) {
    try {
      const source = await realpath(path.resolve(root, row.storagePath));
      if (!source.startsWith(root + path.sep)) throw new Error("Ruta fuera del almacenamiento");
      const colors = await extractBandColors(source);
      if (colors) measured.push({ ...row, colors });
    } catch {
      console.warn(JSON.stringify({ event: "media.band-colors.backfill-skipped", variantId: row.id }));
    }
  }
  const summary = { candidates: rows.length, measured: measured.length, failed: rows.length - measured.length,
    updated: 0, frames: 0, applied: apply, nextCursor: rows.at(-1)?.id ?? null };
  if (!apply || measured.length === 0) return summary;
  return transaction(database, async (client) => {
    const updated: string[] = [];
    for (const item of measured) {
      const result = await client.query(
        `UPDATE naiskos.media_variants SET band_colors=$2 WHERE id=$1 AND sha256=$3 AND band_colors IS NULL RETURNING id`,
        [item.id, JSON.stringify(item.colors), item.sha256]);
      if (result.rowCount) updated.push(item.id);
    }
    // One publication per affected frame/batch, not one per image. Also refresh other
    // frames referencing the same variant, without modifying their preferences.
    const frames = await client.query<{ id: string }>(
      `UPDATE naiskos.frames SET manifest_version=manifest_version+1,updated_at=now()
        WHERE id IN (SELECT frame_id FROM naiskos.frame_media WHERE deleted_at IS NULL AND sync_status='active'
          AND (variant_id=ANY($1::uuid[]) OR poster_variant_id=ANY($1::uuid[]))) RETURNING id`, [updated]);
    for (const frame of frames.rows) await client.query(
      `INSERT INTO naiskos.audit_log (frame_id,action,details) VALUES ($1,'media.band-colors.backfilled',$2)`,
      [frame.id, JSON.stringify({ variants: updated.length })]);
    return { ...summary, updated: updated.length, frames: frames.rowCount ?? 0 };
  });
}
