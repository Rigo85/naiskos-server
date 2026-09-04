import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import {
  PostgresProvisioningStore,
  ProvisioningService,
} from "../src/admin/provisioning.js";
import { ServerConfig } from "../src/config.js";
import { Repository } from "../src/repository.js";
import { MediaWorker, MediaWorkerTelegram } from "../src/worker.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const photoPath = process.env.TEST_PHOTO_PATH;
const videoPath = process.env.TEST_VIDEO_PATH;
const database = databaseUrl
  ? new Pool({ connectionString: databaseUrl, max: 2 })
  : null;

afterAll(async () => {
  await database?.end();
});

class LocalTelegram implements MediaWorkerTelegram {
  readonly messages: Array<{ chatId: number | string; text: string }> = [];

  constructor(private readonly files: Map<string, string>) {}

  async fileSource(fileId: string) {
    const file = this.files.get(fileId);
    if (!file) throw new Error(`Archivo de prueba desconocido: ${fileId}`);
    return { kind: "local" as const, path: file };
  }

  async sendMessage(chatId: number | string, text: string): Promise<void> {
    this.messages.push({ chatId, text });
  }
}

describe.skipIf(!database || !photoPath || !videoPath)(
  "pipeline multimedia PostgreSQL",
  () => {
    it(
      "procesa una foto y un video y publica ambos en el manifiesto",
      async () => {
        if (!database || !photoPath || !videoPath) {
          throw new Error(
            "TEST_DATABASE_URL, TEST_PHOTO_PATH y TEST_VIDEO_PATH son obligatorios",
          );
        }
        const storageRoot = await mkdtemp(
          path.join(os.tmpdir(), "naiskos-storage-integration-"),
        );
        const repository = new Repository(database);
        const provisioning = new ProvisioningService(
          new PostgresProvisioningStore(database),
          "naiskosbot",
        );
        const frame = await provisioning.createFrame({
          name: "Marco multimedia de integración",
        });
        const invitation = await provisioning.createInvitation({
          frameId: frame.frameId,
        });
        const telegramId = `integration-${randomUUID()}`;
        const user = await repository.upsertPendingTelegramUser(
          telegramId,
          "Remitente de integración",
        );
        const photoUniqueId = `photo-${randomUUID()}`;
        const videoUniqueId = `video-${randomUUID()}`;
        const jobIds: string[] = [];

        const telegram = new LocalTelegram(
          new Map([
            ["photo-file", photoPath],
            ["video-file", videoPath],
          ]),
        );
        const config = {
          storageRoot,
          telegramToken: "integration-token",
          workerIntervalMs: 1_000,
          originalRetentionDays: 7,
        } as ServerConfig;
        const worker = new MediaWorker(config, database, telegram);

        try {
          await repository.claimInvitation(invitation.code, user.id);
          expect(
            (await repository.approveTelegramUser(telegramId, "99999"))
              .approved,
          ).toBe(true);

          jobIds.push(
            await repository.enqueueIngest({
              chatId: telegramId,
              telegramFileId: "photo-file",
              telegramFileUniqueId: photoUniqueId,
              kind: "photo",
              mimeType: "image/jpeg",
              originalName: path.basename(photoPath),
              sizeBytes: (await stat(photoPath)).size,
              durationSeconds: null,
              caption: "Foto de integración",
              senderName: "Remitente de integración",
              telegramUserId: user.id,
              frameIds: [frame.frameId],
            }),
          );
          jobIds.push(
            await repository.enqueueIngest({
              chatId: telegramId,
              telegramFileId: "video-file",
              telegramFileUniqueId: videoUniqueId,
              kind: "video",
              mimeType: "video/mp4",
              originalName: path.basename(videoPath),
              sizeBytes: (await stat(videoPath)).size,
              durationSeconds: null,
              caption: "Video de integración",
              senderName: "Remitente de integración",
              telegramUserId: user.id,
              frameIds: [frame.frameId],
            }),
          );

          expect(await worker.runOnce()).toBe(true);
          expect(await worker.runOnce()).toBe(true);
          for (let iteration = 0; iteration < 4; iteration += 1) {
            await database.query(
              `UPDATE naiskos.jobs SET available_at=now()
                WHERE kind='telegram.notify' AND status='pending'
                  AND payload->>'chatId'=$1`,
              [telegramId],
            );
            const pendingNotices = await database.query<{ count: string }>(
              `SELECT count(*)::text AS count FROM naiskos.jobs
                WHERE kind='telegram.notify' AND status='pending'
                  AND payload->>'chatId'=$1`,
              [telegramId],
            );
            if (Number(pendingNotices.rows[0]?.count ?? 0) === 0) break;
            expect(await worker.runOnce()).toBe(true);
          }

          const jobs = await database.query<{ status: string }>(
            "SELECT status FROM naiskos.jobs WHERE id=ANY($1::uuid[]) ORDER BY created_at",
            [jobIds],
          );
          expect(jobs.rows.map((row) => row.status)).toEqual([
            "succeeded",
            "succeeded",
          ]);

          const manifest = await repository.getManifest(
            frame.frameId,
            "https://naiskos.test",
          );
          expect(manifest.version).toBe(2);
          const media = manifest.media as Array<Record<string, unknown>>;
          expect(media).toHaveLength(2);
          expect(new Set(media.map((item) => item.kind))).toEqual(
            new Set(["photo", "video"]),
          );
          expect(
            media.every((item) =>
              String(item.downloadUrl).startsWith(
                "https://naiskos.test/api/v1/files/",
              ),
            ),
          ).toBe(true);
          expect(
            media.find((item) => item.kind === "video")?.posterDownloadUrl,
          ).toMatch(/^https:\/\/naiskos\.test\/api\/v1\/files\//);

          const photo = media.find((item) => item.kind === "photo")!;
          const video = media.find((item) => item.kind === "video")!;
          expect(typeof photo.sizeBytes).toBe("number");
          expect(typeof video.sizeBytes).toBe("number");
          expect(typeof video.durationSeconds).toBe("number");
          expect(typeof video.posterSizeBytes).toBe("number");
          expect(typeof photo.thumbnailSizeBytes).toBe("number");
          expect(typeof video.thumbnailSizeBytes).toBe("number");
          expect(String(photo.thumbnailDownloadUrl)).toMatch(
            /^https:\/\/naiskos\.test\/api\/v1\/files\//,
          );
          expect(String(video.thumbnailDownloadUrl)).toMatch(
            /^https:\/\/naiskos\.test\/api\/v1\/files\//,
          );
          const productionSettings = {
            photoDurationSeconds: 47,
            fadeDurationMs: 321,
            defaultFitMode: "cover",
            order: "oldest",
            volume: 0.27,
            muted: true,
            showCaption: false,
            showSender: false,
          };
          await repository.applyDeviceEvents(frame.frameId, [
            {
              id: randomUUID(),
              type: "settings.updated",
              at: new Date().toISOString(),
              settings: productionSettings,
            },
          ]);
          const configured = await repository.getManifest(
            frame.frameId,
            "https://naiskos.test",
          );
          expect(configured.settingsRevision).toBe(
            Number(manifest.settingsRevision) + 1,
          );
          expect(configured.settings).toEqual(productionSettings);

          await repository.applyDeviceEvents(frame.frameId, [
            {
              id: randomUUID(),
              type: "media.rotation.requested",
              at: new Date().toISOString(),
              mediaId: photo.id,
              rotationDegrees: 90,
            },
            {
              id: randomUUID(),
              type: "media.rotation.requested",
              at: new Date().toISOString(),
              mediaId: video.id,
              rotationDegrees: 90,
            },
          ]);
          expect(await worker.runOnce()).toBe(true);
          expect(await worker.runOnce()).toBe(true);
          const rotated = await repository.getManifest(
            frame.frameId,
            "https://naiskos.test",
          );
          expect(rotated.settingsRevision).toBe(configured.settingsRevision);
          expect(rotated.settings).toEqual(productionSettings);
          expect(
            (rotated.media as Array<Record<string, unknown>>).map((item) =>
              item.rotationDegrees,
            ),
          ).toEqual([90, 90]);

          const variants = await database.query<{
            storagePath: string;
            sha256: string;
          }>(
            `SELECT v.storage_path AS "storagePath", encode(v.sha256, 'hex') AS sha256
               FROM naiskos.media_variants v
               JOIN naiskos.media m ON m.id=v.media_id
              WHERE m.source_unique_id=ANY($1::text[])`,
            [[photoUniqueId, videoUniqueId]],
          );
          expect(variants.rows).toHaveLength(12);
          for (const variant of variants.rows) {
            const contents = await readFile(
              path.join(storageRoot, variant.storagePath),
            );
            expect(createHash("sha256").update(contents).digest("hex")).toBe(
              variant.sha256,
            );
          }
          await repository.applyDeviceEvents(frame.frameId, [
            {
              id: randomUUID(),
              type: "media.deleted",
              at: new Date().toISOString(),
              mediaId: photo.id,
            },
          ]);
          const afterDelete = await repository.getManifest(
            frame.frameId,
            "https://naiskos.test",
          );
          expect((afterDelete.media as unknown[])).toHaveLength(1);
          expect((afterDelete.media as Array<Record<string, unknown>>)[0]?.id).toBe(video.id);
          expect(afterDelete.settings).toEqual(productionSettings);
          expect(telegram.messages).toHaveLength(2);
        } finally {
          await database.query(
            "DELETE FROM naiskos.audit_log WHERE frame_id=$1 OR actor_telegram_user_id=$2",
            [frame.frameId, user.id],
          );
          await database.query("DELETE FROM naiskos.frames WHERE id=$1", [
            frame.frameId,
          ]);
          await database.query(
            "DELETE FROM naiskos.media WHERE source_unique_id=ANY($1::text[])",
            [[photoUniqueId, videoUniqueId]],
          );
          if (jobIds.length) {
            await database.query(
              "DELETE FROM naiskos.jobs WHERE id=ANY($1::uuid[])",
              [jobIds],
            );
          }
          await database.query(
            `DELETE FROM naiskos.jobs
              WHERE kind='telegram.notify' AND payload->>'chatId'=$1`,
            [telegramId],
          );
          await database.query(
            "DELETE FROM naiskos.jobs WHERE payload->>'frameId'=$1",
            [frame.frameId],
          );
          await database.query(
            "DELETE FROM naiskos.telegram_users WHERE id=$1",
            [user.id],
          );
          await rm(storageRoot, { recursive: true, force: true });
        }
      },
      120_000,
    );
  },
);
