import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Pool } from "pg";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";

import {
  PostgresProvisioningStore,
  ProvisioningService,
} from "../src/admin/provisioning.js";
import { Repository } from "../src/repository.js";
import { backfillMediaThumbnails } from "../src/thumbnail-backfill.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const database = databaseUrl ? new Pool({ connectionString: databaseUrl, max: 2 }) : null;

afterAll(async () => {
  await database?.end();
});

describe.skipIf(!database)("backfill de miniaturas PostgreSQL", () => {
  it("genera fuera del manifiesto, activa una vez y luego es idempotente", async () => {
    if (!database) throw new Error("TEST_DATABASE_URL es obligatorio");
    const storageRoot = await mkdtemp(path.join(os.tmpdir(), "naiskos-thumb-backfill-"));
    const displayStoragePath = path.join("objects", "test", `${randomUUID()}.webp`);
    const displayPath = path.join(storageRoot, displayStoragePath);
    await mkdir(path.dirname(displayPath), { recursive: true });
    const displayInfo = await sharp({
      create: { width: 1_280, height: 800, channels: 3, background: "#123456" },
    })
      .webp()
      .toFile(displayPath);
    const displayBytes = await readFile(displayPath);
    const displayHash = createHash("sha256").update(displayBytes).digest();
    const frame = await new ProvisioningService(
      new PostgresProvisioningStore(database),
      "naiskosbot",
    ).createFrame({ name: "Marco de backfill" });
    const mediaId = randomUUID();
    const variantId = randomUUID();
    const sourceUniqueId = `thumbnail-backfill-${randomUUID()}`;

    try {
      await database.query(
        `INSERT INTO naiskos.media (id, kind, status, source_unique_id)
         VALUES ($1,'photo','ready',$2)`,
        [mediaId, sourceUniqueId],
      );
      await database.query(
        `INSERT INTO naiskos.media_variants
           (id, media_id, purpose, width, height, mime_type, extension,
            sha256, size_bytes, storage_path, rotation_degrees)
         VALUES ($1,$2,'display',$3,$4,'image/webp','.webp',$5,$6,$7,0)`,
        [
          variantId,
          mediaId,
          displayInfo.width,
          displayInfo.height,
          displayHash,
          displayInfo.size,
          displayStoragePath,
        ],
      );
      await database.query(
        `INSERT INTO naiskos.frame_media (frame_id, media_id, variant_id)
         VALUES ($1,$2,$3)`,
        [frame.frameId, mediaId, variantId],
      );

      expect(await backfillMediaThumbnails({ storageRoot }, database, true)).toMatchObject({
        candidates: 1,
        generated: 1,
        framesActivated: 0,
        dryRun: true,
      });
      expect(await backfillMediaThumbnails({ storageRoot }, database)).toMatchObject({
        candidates: 1,
        generated: 1,
        framesActivated: 1,
        dryRun: false,
      });
      const manifest = await new Repository(database).getManifest(
        frame.frameId,
        "https://naiskos.test",
      );
      expect((manifest.media[0] as Record<string, unknown>).thumbnailDownloadUrl).toMatch(
        /^https:\/\/naiskos\.test\/api\/v1\/files\//,
      );
      const thumbnail = await database.query<{ width: number; height: number }>(
        `SELECT width, height FROM naiskos.media_variants
          WHERE media_id=$1 AND purpose='thumbnail' AND rotation_degrees=0`,
        [mediaId],
      );
      expect(thumbnail.rows[0]).toEqual({ width: 320, height: 240 });
      expect(await backfillMediaThumbnails({ storageRoot }, database)).toMatchObject({
        candidates: 1,
        generated: 0,
        reused: 1,
        framesActivated: 0,
      });
    } finally {
      await database.query("DELETE FROM naiskos.frames WHERE id=$1", [frame.frameId]);
      await database.query("DELETE FROM naiskos.media WHERE id=$1", [mediaId]);
      await rm(storageRoot, { recursive: true, force: true });
    }
  });
});
