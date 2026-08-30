import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sha256File } from "../src/worker.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("sha256File", () => {
  it("calcula el mismo hash leyendo el archivo como flujo", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "naiskos-hash-"));
    temporaryDirectories.push(directory);
    const file = path.join(directory, "material.bin");
    const contents = Buffer.alloc(9 * 1024 * 1024 + 317, 0x5a);
    await writeFile(file, contents);

    await expect(sha256File(file)).resolves.toEqual(
      createHash("sha256").update(contents).digest(),
    );
  });
});
