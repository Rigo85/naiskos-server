import { createHash, randomUUID } from "node:crypto";
import { access, copyFile, mkdir, mkdtemp, readFile, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ServerConfig } from "./config.js";
import { Database, transaction } from "./db.js";
import { createMediaThumbnail } from "./image-processing.js";

interface ThumbnailCandidate {
  mediaId: string;
  rotationDegrees: 0 | 90 | 180 | 270;
  sourceStoragePath: string;
  thumbnailId: string | null;
  thumbnailStoragePath: string | null;
}

export interface ThumbnailBackfillResult {
  candidates: number;
  generated: number;
  reused: number;
  framesActivated: number;
  dryRun: boolean;
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function sha256File(file: string): Promise<Buffer> {
  const contents = await readFile(file);
  return createHash("sha256").update(contents).digest();
}

export async function backfillMediaThumbnails(
  config: Pick<ServerConfig, "storageRoot">,
  database: Database,
  dryRun = false,
): Promise<ThumbnailBackfillResult> {
  const candidates = await database.query<ThumbnailCandidate>(
    `SELECT DISTINCT fm.media_id AS "mediaId",
            fm.rotation_degrees AS "rotationDegrees",
            CASE WHEN m.kind='video' THEN pv.storage_path ELSE v.storage_path END AS "sourceStoragePath",
            tv.id AS "thumbnailId", tv.storage_path AS "thumbnailStoragePath"
       FROM naiskos.frame_media fm
       JOIN naiskos.media m ON m.id=fm.media_id
       JOIN naiskos.media_variants v ON v.id=fm.variant_id
       LEFT JOIN naiskos.media_variants pv ON pv.id=fm.poster_variant_id
       LEFT JOIN naiskos.media_variants tv
         ON tv.media_id=fm.media_id AND tv.purpose='thumbnail'
        AND tv.rotation_degrees=fm.rotation_degrees
      WHERE fm.deleted_at IS NULL
        AND (m.kind='photo' OR pv.id IS NOT NULL)
      ORDER BY fm.media_id, fm.rotation_degrees`,
  );
  const result: ThumbnailBackfillResult = {
    candidates: candidates.rowCount ?? candidates.rows.length,
    generated: 0,
    reused: 0,
    framesActivated: 0,
    dryRun,
  };

  const missing: ThumbnailCandidate[] = [];
  for (const candidate of candidates.rows) {
    const thumbnailFile = candidate.thumbnailStoragePath
      ? path.join(config.storageRoot, candidate.thumbnailStoragePath)
      : null;
    if (thumbnailFile && (await exists(thumbnailFile))) result.reused += 1;
    else missing.push(candidate);
  }
  if (dryRun) {
    result.generated = missing.length;
    return result;
  }

  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "naiskos-thumbnails-"));
  try {
    for (const candidate of missing) {
      const source = path.join(config.storageRoot, candidate.sourceStoragePath);
      const output = path.join(
        temporaryRoot,
        `${candidate.mediaId}-${candidate.rotationDegrees}.webp`,
      );
      const metadata = await createMediaThumbnail(source, output);
      const sha256 = await sha256File(output);
      const hex = sha256.toString("hex");
      const storagePath = path.join("objects", hex.slice(0, 2), `${hex}.webp`);
      const destination = path.join(config.storageRoot, storagePath);
      await mkdir(path.dirname(destination), { recursive: true });
      if (!(await exists(destination))) {
        const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
        await copyFile(output, temporary);
        await rename(temporary, destination);
      }
      const details = await stat(destination);
      await database.query(
        `INSERT INTO naiskos.media_variants
           (id, media_id, purpose, width, height, mime_type, extension,
            sha256, size_bytes, storage_path, rotation_degrees)
         VALUES ($1,$2,'thumbnail',$3,$4,'image/webp','.webp',$5,$6,$7,$8)
         ON CONFLICT (media_id, purpose, rotation_degrees) DO UPDATE SET
           width=EXCLUDED.width, height=EXCLUDED.height,
           mime_type=EXCLUDED.mime_type, extension=EXCLUDED.extension,
           sha256=EXCLUDED.sha256, size_bytes=EXCLUDED.size_bytes,
           storage_path=EXCLUDED.storage_path`,
        [
          candidate.thumbnailId ?? randomUUID(),
          candidate.mediaId,
          metadata.width,
          metadata.height,
          sha256,
          details.size,
          storagePath,
          candidate.rotationDegrees,
        ],
      );
      result.generated += 1;
    }

    result.framesActivated = await transaction(database, async (client) => {
      const activated = await client.query<{ frameId: string }>(
        `WITH updated AS (
           UPDATE naiskos.frame_media fm
              SET thumbnail_variant_id=tv.id
             FROM naiskos.media_variants tv
            WHERE tv.media_id=fm.media_id AND tv.purpose='thumbnail'
              AND tv.rotation_degrees=fm.rotation_degrees
              AND fm.deleted_at IS NULL
              AND fm.thumbnail_variant_id IS DISTINCT FROM tv.id
           RETURNING fm.frame_id
         ), affected AS (
           SELECT DISTINCT frame_id FROM updated
         )
         UPDATE naiskos.frames f
            SET manifest_version=manifest_version+1, updated_at=now()
           FROM affected
          WHERE f.id=affected.frame_id
         RETURNING f.id AS "frameId"`,
      );
      return activated.rowCount ?? activated.rows.length;
    });
    return result;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
