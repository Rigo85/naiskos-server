import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { Pool } from "pg";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";

import { ServerConfig } from "../src/config.js";
import { IngestJobPayload, Repository } from "../src/repository.js";
import { MediaWorker, MediaWorkerTelegram } from "../src/worker.js";

const execFileAsync = promisify(execFile);
const databaseUrl = process.env.TEST_DATABASE_URL;
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

describe.skipIf(!database)("casos negativos y capacidad PostgreSQL", () => {
  it(
    "deduplica, rechaza, reintenta, recupera locks y libera pending_capacity",
    async () => {
      if (!database) throw new Error("TEST_DATABASE_URL es obligatorio");
      const root = await mkdtemp(path.join(os.tmpdir(), "naiskos-negative-"));
      const storageRoot = path.join(root, "storage");
      const photoPath = path.join(root, "photo.jpg");
      const corruptPath = path.join(root, "corrupt.jpg");
      const longVideoPath = path.join(root, "long.mp4");
      await sharp({
        create: {
          width: 64,
          height: 48,
          channels: 3,
          background: { r: 40, g: 90, b: 130 },
        },
      })
        .jpeg()
        .toFile(photoPath);
      await writeFile(corruptPath, "esto no es una imagen");
      await execFileAsync("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=32x24:r=1",
        "-t",
        "121",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-an",
        "-y",
        longVideoPath,
      ]);

      const frameId = randomUUID();
      const userId = randomUUID();
      const telegramId = `negative-${randomUUID()}`;
      await database.query(
        `INSERT INTO naiskos.frames (id, name) VALUES ($1, 'Marco negativo')`,
        [frameId],
      );
      await database.query(
        `INSERT INTO naiskos.telegram_users
           (id, telegram_id, display_name, status, approved_at)
         VALUES ($1, $2, 'Prueba negativa', 'approved', now())`,
        [userId, telegramId],
      );
      const telegram = new LocalTelegram(
        new Map([
          ["photo", photoPath],
          ["corrupt", corruptPath],
          ["long-video", longVideoPath],
        ]),
      );
      const config = {
        storageRoot,
        workerIntervalMs: 1_000,
        workerLockTimeoutSeconds: 30,
        originalRetentionDays: 7,
        telegramAdminIds: new Set(["negative-admin"]),
      } as ServerConfig;
      const repository = new Repository(database);
      const worker = new MediaWorker(config, database, telegram);
      const payload = (
        fileId: string,
        uniqueId: string,
        kind: "photo" | "video" = "photo",
      ): IngestJobPayload => ({
        chatId: telegramId,
        telegramFileId: fileId,
        telegramFileUniqueId: uniqueId,
        kind,
        mimeType: kind === "photo" ? "image/jpeg" : "video/mp4",
        originalName: kind === "photo" ? `${fileId}.jpg` : `${fileId}.mp4`,
        sizeBytes: null,
        durationSeconds: null,
        caption: uniqueId,
        senderName: "Prueba negativa",
        telegramUserId: userId,
        frameIds: [frameId],
      });

      try {
        const duplicateUniqueId = `duplicate-${randomUUID()}`;
        await repository.enqueueIngest(payload("photo", duplicateUniqueId));
        expect(await worker.runOnce()).toBe(true);
        const versionAfterFirst = Number(
          (
            await database.query<{ version: string }>(
              `SELECT manifest_version::text AS version FROM naiskos.frames WHERE id=$1`,
              [frameId],
            )
          ).rows[0]!.version,
        );
        await repository.enqueueIngest(payload("photo", duplicateUniqueId));
        expect(await worker.runOnce()).toBe(true);
        const afterDuplicate = await repository.getManifest(
          frameId,
          "https://naiskos.test",
        );
        expect(afterDuplicate.version).toBe(versionAfterFirst);
        expect(afterDuplicate.media).toHaveLength(1);
        expect(telegram.messages.at(-1)?.text).toContain("ya estaba");

        const corruptJob = await repository.enqueueIngest(
          payload("corrupt", `corrupt-${randomUUID()}`),
        );
        for (let attempt = 0; attempt < 5; attempt += 1) {
          await database.query(
            "UPDATE naiskos.jobs SET available_at=now() WHERE id=$1",
            [corruptJob],
          );
          expect(await worker.runOnce()).toBe(true);
        }
        const corruptState = await database.query<{
          status: string;
          attempts: number;
        }>("SELECT status, attempts FROM naiskos.jobs WHERE id=$1", [corruptJob]);
        expect(corruptState.rows[0]).toEqual({ status: "failed", attempts: 5 });
        expect(
          telegram.messages.some(({ text }) => text.includes("varios intentos")),
        ).toBe(true);

        const messagesBeforeLongVideo = telegram.messages.length;
        const longJob = await repository.enqueueIngest(
          payload("long-video", `long-${randomUUID()}`, "video"),
        );
        expect(await worker.runOnce()).toBe(true);
        const longState = await database.query<{ status: string; attempts: number }>(
          "SELECT status, attempts FROM naiskos.jobs WHERE id=$1",
          [longJob],
        );
        expect(longState.rows[0]).toEqual({ status: "failed", attempts: 1 });
        expect(telegram.messages.length).toBe(messagesBeforeLongVideo + 2);
        expect(
          (
            await database.query<{ kind: string }>(
              `SELECT kind FROM naiskos.frame_notifications
                WHERE frame_id=$1 AND dedupe_key=$2`,
              [frameId, `ingest-failed:${longJob}`],
            )
          ).rows[0]?.kind,
        ).toBe("media.rejected");

        const abandonedJob = await repository.enqueueIngest(
          payload("photo", `abandoned-${randomUUID()}`),
        );
        await database.query(
          `UPDATE naiskos.jobs SET status='running', attempts=1,
             locked_at=now() - interval '1 hour', locked_by='worker-muerto'
           WHERE id=$1`,
          [abandonedJob],
        );
        expect(await worker.runOnce()).toBe(true);
        expect(
          (
            await database.query<{ status: string }>(
              "SELECT status FROM naiskos.jobs WHERE id=$1",
              [abandonedJob],
            )
          ).rows[0]?.status,
        ).toBe("succeeded");

        await repository.recordTelemetry(frameId, {
          state: "storage-blocked",
          manifestVersion: Number(
            (
              await database.query<{ version: string }>(
                "SELECT manifest_version::text AS version FROM naiskos.frames WHERE id=$1",
                [frameId],
              )
            ).rows[0]!.version,
          ),
          diskUsedPercent: 90,
          lastError: "Almacenamiento al 90.0%",
          lastSyncAt: new Date().toISOString(),
        });
        const capacityJob = await repository.enqueueIngest(
          payload("photo", `capacity-${randomUUID()}`),
        );
        expect(await worker.runOnce()).toBe(true);
        const pending = await database.query<{ syncStatus: string }>(
          `SELECT fm.sync_status AS "syncStatus"
             FROM naiskos.frame_media fm
             JOIN naiskos.media m ON m.id=fm.media_id
            WHERE fm.frame_id=$1 AND m.caption LIKE 'capacity-%'`,
          [frameId],
        );
        expect(pending.rows[0]?.syncStatus).toBe("pending_capacity");
        expect(telegram.messages.at(-2)?.text).toContain("90 %");
        expect(telegram.messages.at(-1)).toMatchObject({ chatId: "negative-admin" });

        await repository.recordTelemetry(frameId, {
          state: "ready",
          manifestVersion: 0,
          diskUsedPercent: 50,
          lastError: null,
          lastSyncAt: new Date().toISOString(),
        });
        const released = await database.query<{ syncStatus: string }>(
          `SELECT fm.sync_status AS "syncStatus"
             FROM naiskos.frame_media fm
             JOIN naiskos.media m ON m.id=fm.media_id
            WHERE fm.frame_id=$1 AND m.caption LIKE 'capacity-%'`,
          [frameId],
        );
        expect(released.rows[0]?.syncStatus).toBe("active");
        const notifications = await repository.getNotifications(frameId);
        expect(
          notifications.filter((item) => item.kind.includes("media") && !item.readAt),
        ).toHaveLength(2);
        expect(
          notifications.find((item) => item.kind.includes("storage"))?.resolvedAt,
        ).toBeTruthy();
        expect(
          (await repository.getManifest(frameId, "https://naiskos.test")).media,
        ).toHaveLength(3);
        expect(
          (
            await database.query<{ status: string }>(
              "SELECT status FROM naiskos.jobs WHERE id=$1",
              [capacityJob],
            )
          ).rows[0]?.status,
        ).toBe("succeeded");

        const actionableNotification = notifications.find((item) =>
          item.kind.includes("media"),
        );
        expect(actionableNotification).toBeTruthy();
        await repository.applyDeviceEvents(frameId, [
          {
            id: randomUUID(),
            type: "notification.read",
            notificationId: actionableNotification!.id,
          },
          {
            id: randomUUID(),
            type: "notification.dismissed",
            notificationId: actionableNotification!.id,
          },
        ]);
        expect(
          (
            await database.query<{ read: boolean; dismissed: boolean }>(
              `SELECT read_at IS NOT NULL AS read,
                      dismissed_at IS NOT NULL AS dismissed
                 FROM naiskos.frame_notifications WHERE id=$1`,
              [actionableNotification!.id],
            )
          ).rows[0],
        ).toEqual({ read: true, dismissed: true });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
