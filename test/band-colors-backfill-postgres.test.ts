import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";
import { PostgresProvisioningStore, ProvisioningService } from "../src/admin/provisioning.js";
import { Repository } from "../src/repository.js";
import { backfillBandColors } from "../src/band-colors-backfill.js";

const database = process.env.TEST_DATABASE_URL ? new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 }) : null;
afterAll(async () => { await database?.end(); });
describe.skipIf(!database)("paletas en PostgreSQL", () => {
  it("publica por lote sin reescribir archivos, configura una sola vez y permite reintento", async () => {
    if (!database) throw new Error("TEST_DATABASE_URL requerido");
    const root = await mkdtemp(path.join(os.tmpdir(), "naiskos-palette-db-"));
    const frame = await new ProvisioningService(new PostgresProvisioningStore(database), "naiskosbot").createFrame({ name: "Palette test" });
    const ids: string[] = [];
    try {
      await mkdir(path.join(root, "objects"));
      for (const kind of ["photo", "video"] as const) {
        const mediaId = randomUUID(), variantId = randomUUID(), posterId = randomUUID();
        ids.push(mediaId);
        const stored = `objects/${mediaId}.png`;
        await sharp({ create: { width: 100, height: 150, channels: 3, background: "#996633" } }).png().toFile(path.join(root, stored));
        const bytes = await readFile(path.join(root, stored));
        await database.query(`INSERT INTO naiskos.media (id,kind,status,source_unique_id) VALUES ($1,$2,'ready',$3)`, [mediaId, kind, mediaId]);
        await database.query(`INSERT INTO naiskos.media_variants
          (id,media_id,purpose,mime_type,extension,sha256,size_bytes,storage_path,width,height)
          VALUES ($1,$2,'display','image/png','.png',$3,$4,$5,100,150)`,
          [variantId, mediaId, createHash("sha256").update(bytes).digest(), bytes.length, stored]);
        if (kind === "video") await database.query(`INSERT INTO naiskos.media_variants
          (id,media_id,purpose,mime_type,extension,sha256,size_bytes,storage_path)
          VALUES ($1,$2,'poster','image/png','.png',$3,$4,$5)`,
          [posterId, mediaId, createHash("sha256").update(bytes).digest(), bytes.length, stored]);
        await database.query(`INSERT INTO naiskos.frame_media (frame_id,media_id,variant_id,poster_variant_id)
          VALUES ($1,$2,$3,$4)`, [frame.frameId, mediaId, variantId, kind === "video" ? posterId : null]);
      }
      const repo = new Repository(database);
      const before = await repo.getManifest(frame.frameId, "https://naiskos.test");
      expect(await backfillBandColors(database, root, frame.frameId)).toMatchObject({ measured: 2, updated: 0 });
      expect(await backfillBandColors(database, root, frame.frameId, true)).toMatchObject({ updated: 2, frames: 1 });
      const after = await repo.getManifest(frame.frameId, "https://naiskos.test");
      expect(after.version).toBe(Number(before.version) + 1);
      expect(after.settings).toEqual(before.settings);
      for (const item of after.media as Array<Record<string, unknown>>) {
        expect(item.bandColors).toHaveLength(2);
        const bytes = await readFile(path.join(root, `objects/${item.id}.png`));
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(item.sha256);
      }
      expect(await backfillBandColors(database, root, frame.frameId, true)).toMatchObject({ candidates: 0, updated: 0 });
      expect((await repo.getManifest(frame.frameId, "https://naiskos.test")).version).toBe(after.version);
    } finally {
      await database.query("DELETE FROM naiskos.frames WHERE id=$1", [frame.frameId]);
      await database.query("DELETE FROM naiskos.media WHERE id=ANY($1::uuid[])", [ids]);
      await rm(root, { recursive: true, force: true });
    }
  });
});
