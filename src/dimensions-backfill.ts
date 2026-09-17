import { realpath } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { Database, transaction } from "./db.js";
import { inspectVideo } from "./video-processing.js";

/** Read existing display files, never thumbnails (which are cropped). No file writes. */
export async function backfillMediaDimensions(
  database: Database,
  storageRoot: string,
  frameId: string,
  apply = false,
) {
  const root = await realpath(storageRoot);
  const candidates = await database.query<{
    id: string;
    kind: string;
    storagePath: string;
    sha256: Buffer;
  }>(
    `SELECT DISTINCT v.id, m.kind, v.storage_path AS "storagePath", v.sha256
       FROM naiskos.frame_media fm
       JOIN naiskos.media_variants v ON v.id=fm.variant_id
       JOIN naiskos.media m ON m.id=fm.media_id
      WHERE fm.frame_id=$1 AND fm.deleted_at IS NULL AND fm.sync_status='active'
        AND v.purpose='display' AND (v.width IS NULL OR v.height IS NULL)
      ORDER BY v.id LIMIT 200`,
    [frameId],
  );
  const measured: Array<{
    id: string;
    width: number;
    height: number;
    sha256: Buffer;
  }> = [];
  // Sequential probes, bounded batch; all probes finish before opening a transaction.
  for (const candidate of candidates.rows) {
    const file = await realpath(path.resolve(root, candidate.storagePath));
    if (!file.startsWith(root + path.sep))
      throw new Error(`Ruta fuera del almacenamiento: ${candidate.id}`);
    const size =
      candidate.kind === "video"
        ? (await inspectVideo(file, 15_000)).video
        : await sharp(file)
            .metadata()
            .then((info) => ({
              displayWidth: info.width,
              displayHeight: info.height,
            }));
    const width = Number(size.displayWidth),
      height = Number(size.displayHeight);
    if (
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width <= 0 ||
      height <= 0
    ) {
      throw new Error(`Dimensiones inválidas: ${candidate.id}`);
    }
    measured.push({
      id: candidate.id,
      width,
      height,
      sha256: candidate.sha256,
    });
  }
  if (!apply || !measured.length)
    return {
      candidates: measured.length,
      updated: 0,
      frames: 0,
      applied: apply,
    };
  return transaction(database, async (client) => {
    const updated: string[] = [];
    for (const item of measured) {
      const result = await client.query(
        `UPDATE naiskos.media_variants SET width=$2,height=$3
          WHERE id=$1 AND sha256=$4 AND (width IS NULL OR height IS NULL) RETURNING id`,
        [item.id, item.width, item.height, item.sha256],
      );
      if (result.rowCount) updated.push(item.id);
    }
    const frames = await client.query<{ id: string }>(
      `UPDATE naiskos.frames SET manifest_version=manifest_version+1,updated_at=now()
        WHERE id IN (SELECT frame_id FROM naiskos.frame_media
          WHERE variant_id=ANY($1::uuid[]) AND deleted_at IS NULL AND sync_status='active') RETURNING id`,
      [updated],
    );
    for (const frame of frames.rows) {
      await client.query(
        `INSERT INTO naiskos.audit_log (frame_id,action,details)
          VALUES ($1,'media.dimensions.backfilled',$2)`,
        [frame.id, JSON.stringify({ variants: updated.length })],
      );
    }
    return {
      candidates: measured.length,
      updated: updated.length,
      frames: frames.rowCount ?? 0,
      applied: true,
    };
  });
}
