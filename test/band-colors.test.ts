import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { extractBandColors } from "../src/band-colors.js";

describe("paleta estática", () => {
  it("extrae dos tonos del material completo y falla sin impedir el pipeline", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "naiskos-palette-test-"));
    try {
      const input = path.join(root, "image.png");
      await sharp({ create: { width: 64, height: 128, channels: 3, background: "#ff0000" } })
        .composite([{ input: await sharp({ create: { width: 64, height: 64, channels: 3, background: "#0000ff" } })
          .png().toBuffer(), top: 64, left: 0 }]).png().toFile(input);
      const colors = await extractBandColors(input);
      expect(colors).toHaveLength(2);
      expect(colors![0]).not.toBe(colors![1]);
      expect(colors!.every((color) => /^#[a-f0-9]{6}$/.test(color))).toBe(true);
      expect(await extractBandColors(input)).toEqual(colors);
      expect(await extractBandColors(path.join(root, "missing"))).toBeNull();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
