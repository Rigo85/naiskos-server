import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import sharp from "sharp";

import { ServerConfig } from "./config.js";
import { Database, transaction } from "./db.js";
import {
  createMediaThumbnail,
  createPhotoDisplayMaster,
  createRotatedPhotoVariant,
} from "./image-processing.js";
import { IngestJobPayload, RotateMediaJobPayload } from "./repository.js";
import { upsertFrameNotification } from "./notifications.js";
import { TelegramFileSource } from "./telegram.js";
import {
  claimTelegramMediaNoticeBatch,
  completeTelegramMediaNoticeBatch,
  formatTelegramMediaNotice,
  queueTelegramMediaNotice,
  retryTelegramMediaNoticeBatch,
  TelegramMediaNoticeCategory,
} from "./telegram-media-notifications.js";
import {
  createVideoRenditions,
  createRotatedVideoRenditions,
  RejectedVideoError,
} from "./video-processing.js";

interface ClaimedJob {
  id: string;
  kind: "telegram.ingest" | "media.rotate";
  payload: IngestJobPayload | RotateMediaJobPayload;
  attempts: number;
}

interface StoredVariant {
  purpose: "original" | "display" | "poster" | "thumbnail";
  sha256: Buffer;
  storagePath: string;
  extension: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  rotationDegrees: 0 | 90 | 180 | 270;
}

interface PublishResult {
  added: number;
  duplicates: number;
  pendingCapacity: number;
}

export interface MediaWorkerTelegram {
  fileSource(fileId: string): Promise<TelegramFileSource>;
  sendMessage(chatId: number | string, text: string): Promise<unknown>;
}

export class MediaWorker {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private activeTick: Promise<void> | null = null;
  private readonly workerId = `${os.hostname()}:${process.pid}`;

  constructor(
    private readonly config: ServerConfig,
    private readonly database: Database,
    private readonly telegram: MediaWorkerTelegram,
  ) {}

  start(): void {
    this.timer = setInterval(
      () => this.scheduleTick(),
      this.config.workerIntervalMs,
    );
    this.timer.unref();
    this.scheduleTick();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.activeTick;
  }

  private scheduleTick(): void {
    if (this.activeTick) return;
    this.activeTick = this.runOnce().then(() => undefined).finally(() => {
      this.activeTick = null;
    });
  }

  async runOnce(): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    try {
      await this.recoverAbandonedJobs();
      const notification = await claimTelegramMediaNoticeBatch(
        this.database,
        this.workerId,
      );
      if (notification) {
        try {
          await this.telegram.sendMessage(
            notification.chatId,
            formatTelegramMediaNotice(
              notification.category,
              notification.count,
            ),
          );
          await completeTelegramMediaNoticeBatch(this.database, notification);
        } catch (error) {
          const retryAfterSeconds = await retryTelegramMediaNoticeBatch(
            this.database,
            notification,
            error,
          );
          console.warn(
            JSON.stringify({
              event: "telegram.media_notification.retry_scheduled",
              timestamp: new Date().toISOString(),
              chatId: notification.chatId,
              category: notification.category,
              count: notification.count,
              retryAfterSeconds,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        }
        return true;
      }
      const job = await this.claim();
      if (!job) return false;
      const startedAt = Date.now();
      const memoryBefore = memorySnapshot();
      try {
        await this.process(job);
      } finally {
        console.info(
          JSON.stringify({
            event: "media.job.completed_cycle",
            timestamp: new Date().toISOString(),
            startedAt: new Date(startedAt).toISOString(),
            pid: process.pid,
            jobId: job.id,
            kind: job.kind,
            attempt: job.attempts,
            durationMs: Date.now() - startedAt,
            memoryBefore,
            memoryAfter: memorySnapshot(),
          }),
        );
      }
      return true;
    } catch (error) {
      console.error("Fallo del worker de medios", error);
      return false;
    } finally {
      this.busy = false;
    }
  }

  private async recoverAbandonedJobs(): Promise<void> {
    const recovered = await this.database.query<{ id: string }>(
      `UPDATE naiskos.jobs
          SET status='pending', available_at=now(), locked_at=NULL, locked_by=NULL,
              last_error=concat_ws('; ', NULLIF(last_error, ''),
                'Lock abandonado recuperado automáticamente')
        WHERE status='running' AND locked_at <
              now() - make_interval(secs => $1)
        RETURNING id`,
      [this.config.workerLockTimeoutSeconds],
    );
    if (recovered.rowCount) {
      console.warn(
        JSON.stringify({
          event: "media.jobs.recovered",
          timestamp: new Date().toISOString(),
          count: recovered.rowCount,
          jobIds: recovered.rows.map((row) => row.id),
        }),
      );
    }
  }

  private async claim(): Promise<ClaimedJob | null> {
    return transaction(this.database, async (client) => {
      const result = await client.query<ClaimedJob>(
        `WITH candidate AS (
           SELECT id FROM naiskos.jobs
            WHERE status = 'pending' AND available_at <= now()
              AND kind IN ('telegram.ingest', 'media.rotate')
            ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
         )
         UPDATE naiskos.jobs j
            SET status = 'running', attempts = attempts + 1, locked_at = now(), locked_by = $1
           FROM candidate c WHERE j.id = c.id
         RETURNING j.id, j.kind, j.payload, j.attempts`,
        [this.workerId],
      );
      return result.rows[0] ?? null;
    });
  }

  private async process(job: ClaimedJob): Promise<void> {
    if (job.kind === "media.rotate") {
      await this.processRotation(job as ClaimedJob & { payload: RotateMediaJobPayload });
      return;
    }
    await this.processIngest(job as ClaimedJob & { payload: IngestJobPayload });
  }

  private async processIngest(
    job: ClaimedJob & { payload: IngestJobPayload },
  ): Promise<void> {
    const temporaryRoot = await mkdtemp(
      path.join(os.tmpdir(), "naiskos-media-"),
    );
    let result: PublishResult;
    try {
      const input = path.join(temporaryRoot, "input");
      const source = await this.telegram.fileSource(
        job.payload.telegramFileId,
      );
      if (source.kind === "local") {
        await pipeline(
          createReadStream(source.path),
          createWriteStream(input, { mode: 0o600 }),
        );
      } else {
        if (!source.response.ok || !source.response.body)
          throw new Error(`Telegram file HTTP ${source.response.status}`);
        await pipeline(
          Readable.fromWeb(source.response.body as never),
          createWriteStream(input, { mode: 0o600 }),
        );
      }

      const originalExtension = safeExtension(
        job.payload.originalName,
        job.payload.mimeType,
        job.payload.kind,
      );
      let variants: StoredVariant[];
      if (job.payload.kind === "photo") {
        const display = path.join(temporaryRoot, "display.webp");
        const thumbnail = path.join(temporaryRoot, "thumbnail.webp");
        await createPhotoDisplayMaster(input, display);
        const thumbnailMetadata = await createMediaThumbnail(display, thumbnail);
        const metadata = await sharp(display).metadata();
        variants = [
          await this.storeVariant(
            input,
            "original",
            originalExtension,
            job.payload.mimeType ?? mimeFor(originalExtension),
          ),
          await this.storeVariant(
            display,
            "display",
            ".webp",
            "image/webp",
            metadata.width ?? null,
            metadata.height ?? null,
          ),
          await this.storeVariant(
            thumbnail,
            "thumbnail",
            ".webp",
            "image/webp",
            thumbnailMetadata.width,
            thumbnailMetadata.height,
          ),
        ];
      } else {
        const display = path.join(temporaryRoot, "display.mp4");
        const poster = path.join(temporaryRoot, "poster.jpg");
        const thumbnail = path.join(temporaryRoot, "thumbnail.webp");
        const result = await createVideoRenditions(input, display, poster);
        const thumbnailMetadata = await createMediaThumbnail(poster, thumbnail);
        variants = [
          await this.storeVariant(
            input,
            "original",
            originalExtension,
            job.payload.mimeType ?? mimeFor(originalExtension),
          ),
          await this.storeVariant(
            display,
            "display",
            ".mp4",
            "video/mp4",
            null,
            null,
            result.display.durationSeconds,
          ),

          await this.storeVariant(poster, "poster", ".jpg", "image/jpeg"),
          await this.storeVariant(
            thumbnail,
            "thumbnail",
            ".webp",
            "image/webp",
            thumbnailMetadata.width,
            thumbnailMetadata.height,
          ),
        ];
      }

      result = await this.publish(job, variants);
    } catch (error) {
      const retrying = await this.fail(job, error);
      if (!retrying) {
        await this.notifyPermanentIngestFailure(job, error);
      }
      return;
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }

    try {
      if (result.pendingCapacity > 0) {
        await this.queueOutcomeNotices(
          job.payload.chatId,
          "media.capacity",
          "admin.media.capacity",
        );
      } else if (result.added > 0) {
        await queueTelegramMediaNotice(
          this.database,
          job.payload.chatId,
          "media.ready",
        );
      } else {
        await queueTelegramMediaNotice(
          this.database,
          job.payload.chatId,
          "media.duplicate",
        );
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "telegram.media_notification.queue_failed",
          timestamp: new Date().toISOString(),
          jobId: job.id,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  private async storeVariant(
    source: string,
    purpose: StoredVariant["purpose"],
    extension: string,
    mimeType: string,
    width: number | null = null,
    height: number | null = null,
    durationSeconds: number | null = null,
  ): Promise<StoredVariant> {
    const sha256 = await sha256File(source);
    const hex = sha256.toString("hex");
    const storagePath = path.join(
      "objects",
      hex.slice(0, 2),
      `${hex}${extension}`,
    );
    const destination = path.join(this.config.storageRoot, storagePath);
    await mkdir(path.dirname(destination), { recursive: true });
    try {
      await access(destination);
    } catch {
      const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
      await copyFile(source, temporary);
      await rename(temporary, destination);
    }
    const details = await stat(destination);
    return {
      purpose,
      sha256,
      storagePath,
      extension,
      mimeType,
      sizeBytes: details.size,
      width,
      height,
      durationSeconds,
      rotationDegrees: 0,
    };
  }

  private async publish(
    job: ClaimedJob & { payload: IngestJobPayload },
    variants: StoredVariant[],
  ): Promise<PublishResult> {
    return transaction(this.database, async (client) => {
      const mediaResult = await client.query<{ id: string }>(
        `INSERT INTO naiskos.media
           (kind, status, source_unique_id, sender_telegram_user_id, caption, original_delete_after)
         VALUES ($1, 'ready', $2, $3, $4, now() + make_interval(days => $5))
         ON CONFLICT (source, source_unique_id) DO UPDATE SET status = 'ready', updated_at = now()
         RETURNING id`,
        [
          job.payload.kind,
          job.payload.telegramFileUniqueId,
          job.payload.telegramUserId,
          job.payload.caption,
          this.config.originalRetentionDays,
        ],
      );
      const mediaId = mediaResult.rows[0]!.id;
      const ids = new Map<string, string>();
      for (const variant of variants) {
        const id = randomUUID();
        await client
          .query(
            `INSERT INTO naiskos.media_variants
             (id, media_id, purpose, width, height, duration_seconds, mime_type, extension, sha256, size_bytes, storage_path, rotation_degrees)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           ON CONFLICT (media_id, purpose, rotation_degrees) DO UPDATE SET
             width=EXCLUDED.width, height=EXCLUDED.height, duration_seconds=EXCLUDED.duration_seconds,
             mime_type=EXCLUDED.mime_type, extension=EXCLUDED.extension, sha256=EXCLUDED.sha256,
             size_bytes=EXCLUDED.size_bytes, storage_path=EXCLUDED.storage_path
           RETURNING id`,
            [
              id,
              mediaId,
              variant.purpose,
              variant.width,
              variant.height,
              variant.durationSeconds,
              variant.mimeType,
              variant.extension,
              variant.sha256,
              variant.sizeBytes,
              variant.storagePath,
              variant.rotationDegrees,
            ],
          )
          .then((result) =>
            ids.set(variant.purpose, result.rows[0].id as string),
          );
      }
      const result: PublishResult = { added: 0, duplicates: 0, pendingCapacity: 0 };
      for (const frameId of job.payload.frameIds) {
        const existing = await client.query<{ deletedAt: Date | null }>(
          `SELECT deleted_at AS "deletedAt" FROM naiskos.frame_media
            WHERE frame_id=$1 AND media_id=$2 FOR UPDATE`,
          [frameId, mediaId],
        );
        if (existing.rows[0] && existing.rows[0].deletedAt === null) {
          const thumbnailUpdated = await client.query(
            `UPDATE naiskos.frame_media
                SET thumbnail_variant_id=$3
              WHERE frame_id=$1 AND media_id=$2
                AND thumbnail_variant_id IS DISTINCT FROM $3`,
            [frameId, mediaId, ids.get("thumbnail") ?? null],
          );
          if (thumbnailUpdated.rowCount) {
            await client.query(
              "UPDATE naiskos.frames SET manifest_version=manifest_version+1, updated_at=now() WHERE id=$1",
              [frameId],
            );
          }
          result.duplicates += 1;
          continue;
        }
        const runtime = await client.query<{ diskUsedPercent: number | null }>(
          `SELECT disk_used_percent::double precision AS "diskUsedPercent"
             FROM naiskos.frame_runtime WHERE frame_id=$1`,
          [frameId],
        );
        const pendingCapacity = Number(runtime.rows[0]?.diskUsedPercent ?? 0) >= 90;
        await client.query(
          `INSERT INTO naiskos.frame_media
             (frame_id, media_id, variant_id, poster_variant_id,
              thumbnail_variant_id, position, sync_status)
           VALUES ($1, $2, $3, $4, $5, -extract(epoch FROM now())::bigint, $6)
           ON CONFLICT (frame_id, media_id) DO UPDATE SET
             variant_id=EXCLUDED.variant_id, poster_variant_id=EXCLUDED.poster_variant_id,
             thumbnail_variant_id=EXCLUDED.thumbnail_variant_id,
             deleted_at=NULL, purge_after=NULL, sync_status=EXCLUDED.sync_status`,
          [
            frameId,
            mediaId,
            ids.get("display"),
            ids.get("poster") ?? null,
            ids.get("thumbnail") ?? null,
            pendingCapacity ? "pending_capacity" : "active",
          ],
        );
        if (pendingCapacity) {
          result.pendingCapacity += 1;
          await upsertFrameNotification(client, {
            frameId,
            kind: "storage.media.pending_capacity",
            severity: "error",
            title: "Contenido pendiente por falta de espacio",
            message:
              "Llegó contenido nuevo, pero este marco supera el 90 % de almacenamiento. Libera espacio para sincronizarlo.",
            dedupeKey: "storage-capacity",
            details: { mediaId, jobId: job.id },
          });
        } else {
          result.added += 1;
          await client.query(
            "UPDATE naiskos.frames SET manifest_version = manifest_version + 1, updated_at = now() WHERE id = $1",
            [frameId],
          );
        }
        await client.query(
          `INSERT INTO naiskos.audit_log (frame_id, actor_telegram_user_id, action, details)
           VALUES ($1, $2, $3, $4)`,
          [
            frameId,
            job.payload.telegramUserId,
            pendingCapacity ? "media.pending_capacity" : "media.ready",
            JSON.stringify({ mediaId, jobId: job.id }),
          ],
        );
      }
      await client.query(
        `UPDATE naiskos.jobs SET status='succeeded', completed_at=now(),
                locked_at=NULL, locked_by=NULL, last_error=NULL WHERE id=$1`,
        [job.id],
      );
      return result;
    });
  }

  private async processRotation(
    job: ClaimedJob & { payload: RotateMediaJobPayload },
  ): Promise<void> {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "naiskos-rotate-"));
    try {
      const sourceResult = await this.database.query<{
        kind: "photo" | "video";
        displayPath: string;
      }>(
        `SELECT m.kind, v.storage_path AS "displayPath"
           FROM naiskos.frame_media fm
           JOIN naiskos.media m ON m.id=fm.media_id
           JOIN naiskos.media_variants v
             ON v.media_id=m.id AND v.purpose='display' AND v.rotation_degrees=0
          WHERE fm.frame_id=$1 AND fm.media_id=$2 AND fm.deleted_at IS NULL
          LIMIT 1`,
        [job.payload.frameId, job.payload.mediaId],
      );
      const source = sourceResult.rows[0];
      if (!source) throw new Error("El medio ya no está disponible en el marco");

      if (job.payload.rotationDegrees === 0) {
        await this.activateRotation(job);
        return;
      }

      const existing = await this.database.query<{ purpose: string }>(
        `SELECT purpose FROM naiskos.media_variants
          WHERE media_id=$1 AND purpose IN ('display', 'poster', 'thumbnail')
            AND rotation_degrees=$2`,
        [job.payload.mediaId, job.payload.rotationDegrees],
      );
      const hasDisplay = existing.rows.some((row) => row.purpose === "display");
      const hasPoster = existing.rows.some((row) => row.purpose === "poster");
      const hasThumbnail = existing.rows.some(
        (row) => row.purpose === "thumbnail",
      );
      if (!hasDisplay || !hasThumbnail || (source.kind === "video" && !hasPoster)) {
        const input = path.join(this.config.storageRoot, source.displayPath);
        if (source.kind === "photo") {
          const display = path.join(temporaryRoot, "display.webp");
          const thumbnail = path.join(temporaryRoot, "thumbnail.webp");
          const metadata = await createRotatedPhotoVariant(
            input,
            display,
            job.payload.rotationDegrees,
          );
          const thumbnailMetadata = await createMediaThumbnail(display, thumbnail);
          const variant = await this.storeVariant(
            display,
            "display",
            ".webp",
            "image/webp",
            metadata.width,
            metadata.height,
          );
          variant.rotationDegrees = job.payload.rotationDegrees;
          const thumbnailVariant = await this.storeVariant(
            thumbnail,
            "thumbnail",
            ".webp",
            "image/webp",
            thumbnailMetadata.width,
            thumbnailMetadata.height,
          );
          thumbnailVariant.rotationDegrees = job.payload.rotationDegrees;
          await this.publishRotationVariants(job.payload.mediaId, [
            variant,
            thumbnailVariant,
          ]);
        } else {
          const display = path.join(temporaryRoot, "display.mp4");
          const poster = path.join(temporaryRoot, "poster.jpg");
          const thumbnail = path.join(temporaryRoot, "thumbnail.webp");
          const result = await createRotatedVideoRenditions(
            input,
            display,
            poster,
            job.payload.rotationDegrees,
          );
          const thumbnailMetadata = await createMediaThumbnail(poster, thumbnail);
          const displayVariant = await this.storeVariant(
            display,
            "display",
            ".mp4",
            "video/mp4",
            result.display.video.displayWidth,
            result.display.video.displayHeight,
            result.display.durationSeconds,
          );
          displayVariant.rotationDegrees = job.payload.rotationDegrees;
          const posterVariant = await this.storeVariant(
            poster,
            "poster",
            ".jpg",
            "image/jpeg",
          );
          posterVariant.rotationDegrees = job.payload.rotationDegrees;
          const thumbnailVariant = await this.storeVariant(
            thumbnail,
            "thumbnail",
            ".webp",
            "image/webp",
            thumbnailMetadata.width,
            thumbnailMetadata.height,
          );
          thumbnailVariant.rotationDegrees = job.payload.rotationDegrees;
          await this.publishRotationVariants(job.payload.mediaId, [
            displayVariant,
            posterVariant,
            thumbnailVariant,
          ]);
        }
      }
      await this.activateRotation(job);
    } catch (error) {
      const retrying = await this.fail(job, error);
      if (!retrying) {
        await upsertFrameNotification(this.database, {
          frameId: job.payload.frameId,
          kind: "media.rotation.failed",
          severity: "error",
          title: "No se pudo rotar el contenido",
          message:
            "La orientación solicitada no pudo procesarse. El contenido anterior permanece disponible.",
          dedupeKey: `rotation-failed:${job.id}`,
          details: { mediaId: job.payload.mediaId, jobId: job.id },
        });
      }
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }

  private async publishRotationVariants(
    mediaId: string,
    variants: StoredVariant[],
  ): Promise<void> {
    await transaction(this.database, async (client) => {
      for (const variant of variants) {
        await client.query(
          `INSERT INTO naiskos.media_variants
             (id, media_id, purpose, width, height, duration_seconds, mime_type,
              extension, sha256, size_bytes, storage_path, rotation_degrees)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           ON CONFLICT (media_id, purpose, rotation_degrees) DO NOTHING`,
          [
            randomUUID(),
            mediaId,
            variant.purpose,
            variant.width,
            variant.height,
            variant.durationSeconds,
            variant.mimeType,
            variant.extension,
            variant.sha256,
            variant.sizeBytes,
            variant.storagePath,
            variant.rotationDegrees,
          ],
        );
      }
    });
  }

  private async activateRotation(
    job: ClaimedJob & { payload: RotateMediaJobPayload },
  ): Promise<void> {
    await transaction(this.database, async (client) => {
      const superseded = await client.query(
        `SELECT 1 FROM naiskos.jobs
          WHERE kind='media.rotate' AND status='pending'
            AND payload->>'frameId'=$1 AND payload->>'mediaId'=$2
          LIMIT 1`,
        [job.payload.frameId, job.payload.mediaId],
      );
      if (superseded.rowCount) {
        await client.query(
          `UPDATE naiskos.jobs SET status='failed', completed_at=now(),
                  last_error='Sustituida por una solicitud de rotación posterior'
            WHERE id=$1`,
          [job.id],
        );
        return;
      }

      const variants = await client.query<{ purpose: string; id: string }>(
        `SELECT purpose, id FROM naiskos.media_variants
          WHERE media_id=$1 AND rotation_degrees=$2
            AND purpose IN ('display', 'poster', 'thumbnail')`,
        [job.payload.mediaId, job.payload.rotationDegrees],
      );
      const displayId = variants.rows.find((row) => row.purpose === "display")?.id;
      const posterId = variants.rows.find((row) => row.purpose === "poster")?.id ?? null;
      const thumbnailId =
        variants.rows.find((row) => row.purpose === "thumbnail")?.id ?? null;
      if (!displayId) throw new Error("La variante rotada no quedó disponible");
      const updated = await client.query(
        `UPDATE naiskos.frame_media
            SET variant_id=$3, poster_variant_id=$4,
                thumbnail_variant_id=$5, rotation_degrees=$6
          WHERE frame_id=$1 AND media_id=$2 AND deleted_at IS NULL
            AND (rotation_degrees IS DISTINCT FROM $6
              OR variant_id IS DISTINCT FROM $3
              OR poster_variant_id IS DISTINCT FROM $4
              OR thumbnail_variant_id IS DISTINCT FROM $5)`,
        [
          job.payload.frameId,
          job.payload.mediaId,
          displayId,
          posterId,
          thumbnailId,
          job.payload.rotationDegrees,
        ],
      );
      if (updated.rowCount) {
        await client.query(
          `UPDATE naiskos.frames SET manifest_version=manifest_version+1, updated_at=now()
            WHERE id=$1`,
          [job.payload.frameId],
        );
        await client.query(
          `INSERT INTO naiskos.audit_log (frame_id, action, details)
           VALUES ($1, 'media.rotated', $2)`,
          [
            job.payload.frameId,
            JSON.stringify({
              mediaId: job.payload.mediaId,
              rotationDegrees: job.payload.rotationDegrees,
              jobId: job.id,
              deviceEventId: job.payload.deviceEventId,
            }),
          ],
        );
      }
      await client.query(
        `UPDATE naiskos.jobs SET status='succeeded', completed_at=now(),
                locked_at=NULL, locked_by=NULL, last_error=NULL WHERE id=$1`,
        [job.id],
      );
    });
  }

  private async fail(job: ClaimedJob, error: unknown): Promise<boolean> {
    const message =
      error instanceof Error
        ? error.message.slice(0, 2_000)
        : String(error).slice(0, 2_000);
    const retry = !(error instanceof RejectedVideoError) && job.attempts < 5;
    await this.database.query(
      `UPDATE naiskos.jobs SET status=$2, available_at=now() + make_interval(secs => $3),
         locked_at=NULL, locked_by=NULL, last_error=$4, completed_at=CASE WHEN $2='failed' THEN now() END
       WHERE id=$1`,
      [
        job.id,
        retry ? "pending" : "failed",
        Math.min(300, 2 ** job.attempts * 5),
        message,
      ],
    );
    return retry;
  }

  private async notifyPermanentIngestFailure(
    job: ClaimedJob & { payload: IngestJobPayload },
    error: unknown,
  ): Promise<void> {
    const rejected = error instanceof RejectedVideoError;
    const detail = error instanceof Error ? error.message : String(error);
    const message = rejected
      ? detail
      : "No se pudo procesar el archivo después de varios intentos. Comprueba que no esté dañado y vuelve a enviarlo.";
    for (const frameId of job.payload.frameIds) {
      await upsertFrameNotification(this.database, {
        frameId,
        kind: rejected ? "media.rejected" : "media.processing.failed",
        severity: "error",
        title: rejected ? "Contenido rechazado" : "Error al procesar contenido",
        message,
        dedupeKey: `ingest-failed:${job.id}`,
        details: { jobId: job.id, kind: job.payload.kind },
      });
    }
    await this.queueOutcomeNotices(
      job.payload.chatId,
      rejected ? "media.rejected" : "media.failed",
      rejected ? "admin.media.rejected" : "admin.media.failed",
    );
  }

  private async queueOutcomeNotices(
    senderChatId: string,
    senderCategory: TelegramMediaNoticeCategory,
    administratorCategory: TelegramMediaNoticeCategory,
  ): Promise<void> {
    await queueTelegramMediaNotice(
      this.database,
      senderChatId,
      senderCategory,
    );
    for (const adminId of this.config.telegramAdminIds) {
      if (adminId === senderChatId) continue;
      await queueTelegramMediaNotice(
        this.database,
        adminId,
        administratorCategory,
      );
    }
  }
}

export async function sha256File(file: string): Promise<Buffer> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest();
}

function memorySnapshot(): Record<string, number> {
  const memory = process.memoryUsage();
  const cache = sharp.cache();
  const counters = sharp.counters();
  return {
    rssMiB: bytesToMiB(memory.rss),
    heapUsedMiB: bytesToMiB(memory.heapUsed),
    externalMiB: bytesToMiB(memory.external),
    arrayBuffersMiB: bytesToMiB(memory.arrayBuffers),
    sharpCacheCurrentMiB: cache.memory.current,
    sharpCacheHighMiB: cache.memory.high,
    sharpQueue: counters.queue,
    sharpProcessing: counters.process,
  };
}

function bytesToMiB(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 10) / 10;
}

function safeExtension(
  name: string | null,
  mimeType: string | null,
  kind: "photo" | "video",
): string {
  const candidate = name ? path.extname(name).toLowerCase() : "";
  if (/^\.[a-z0-9]{2,5}$/.test(candidate)) return candidate;
  if (mimeType === "image/png") return ".png";
  if (mimeType === "image/webp") return ".webp";
  return kind === "photo" ? ".jpg" : ".mp4";
}

function mimeFor(extension: string): string {
  return (
    (
      {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".webp": "image/webp",
        ".mp4": "video/mp4",
      } as Record<string, string>
    )[extension] ?? "application/octet-stream"
  );
}
