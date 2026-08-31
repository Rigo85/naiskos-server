import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import {
  createMediaThumbnail,
  createPhotoDisplayMaster,
  createRotatedPhotoVariant,
} from "../src/image-processing.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("createMediaThumbnail", () => {
  it("produce un WebP 4:3 pequeño para la cuadrícula", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "naiskos-thumbnail-"));
    temporaryRoots.push(directory);
    const input = path.join(directory, "display.webp");
    const output = path.join(directory, "thumbnail.webp");
    await sharp({
      create: { width: 1_280, height: 1_920, channels: 3, background: "#654321" },
    })
      .webp()
      .toFile(input);

    await createMediaThumbnail(input, output);

    const metadata = await sharp(output).metadata();
    expect(metadata).toMatchObject({ format: "webp", width: 320, height: 240 });
  });
});

async function convert(width: number, height: number) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "naiskos-photo-"));
  temporaryRoots.push(directory);
  const input = path.join(directory, "input.jpg");
  const output = path.join(directory, "output.webp");
  await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: "#b26b32",
    },
  })
    .jpeg()
    .toFile(input);
  await createPhotoDisplayMaster(input, output);
  return sharp(output).metadata();
}

describe("createPhotoDisplayMaster", () => {
  it("conserva resolución suficiente para cover en una foto horizontal", async () => {
    const metadata = await convert(6_000, 4_000);
    expect(metadata.format).toBe("webp");
    expect(metadata.width).toBe(1_280);
    expect(metadata.height).toBe(853);
  });

  it("conserva resolución suficiente para cover en una foto vertical", async () => {
    const metadata = await convert(4_000, 6_000);
    expect(metadata.format).toBe("webp");
    expect(metadata.width).toBe(1_280);
    expect(metadata.height).toBe(1_920);
  });

  it("no amplía una imagen menor que la pantalla", async () => {
    const metadata = await convert(640, 400);
    expect(metadata.width).toBe(640);
    expect(metadata.height).toBe(400);
  });
});

describe("createRotatedPhotoVariant", () => {
  it("rota siempre desde el maestro normalizado y conserva WebP", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "naiskos-rotation-"));
    temporaryRoots.push(directory);
    const input = path.join(directory, "master.webp");
    const output = path.join(directory, "rotated.webp");
    await sharp({
      create: { width: 1_280, height: 853, channels: 3, background: "#123456" },
    })
      .webp()
      .toFile(input);

    await createRotatedPhotoVariant(input, output, 90);

    const metadata = await sharp(output).metadata();
    expect(metadata).toMatchObject({ format: "webp", width: 853, height: 1_280 });
  });
});
