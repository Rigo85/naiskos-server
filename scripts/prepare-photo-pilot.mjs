import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import sharp from "sharp";

import { createPhotoDisplayMaster } from "../dist/image-processing.js";

const source = path.resolve(process.argv[2] ?? "../fotos-prueba");
const limit = Number(process.argv[3] ?? Number.POSITIVE_INFINITY);
if (!(Number.isInteger(limit) || limit === Number.POSITIVE_INFINITY) || limit < 1) {
  throw new Error("El límite debe ser un entero positivo");
}

const target = path.join(source, "procesadas-1280x800-webp-q88");
const checkpointFile = path.join(target, ".checkpoint.json");
await mkdir(target, { recursive: true });

const sourceNames = (await readdir(source, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && /\.jpe?g$/i.test(entry.name))
  .map((entry) => entry.name)
  .sort((left, right) => right.localeCompare(left, "en"));

const checkpoint = await readCheckpoint(checkpointFile);
let processed = 0;
for (const sourceName of sourceNames) {
  if (checkpoint.items.some((item) => item.source === sourceName)) continue;
  if (processed >= limit) break;

  const input = path.join(source, sourceName);
  const temporary = path.join(target, `.${process.pid}.webp.tmp`);
  await createPhotoDisplayMaster(input, temporary);
  const contents = await readFile(temporary);
  const sha256 = createHash("sha256").update(contents).digest("hex");
  const filename = `${sha256}.webp`;
  const output = path.join(target, filename);
  try {
    await access(output);
    await rm(temporary, { force: true });
  } catch {
    await rename(temporary, output);
  }

  const [sourceMetadata, outputMetadata, sourceDetails, outputDetails] =
    await Promise.all([
      sharp(input).metadata(),
      sharp(output).metadata(),
      stat(input),
      stat(output),
    ]);
  checkpoint.items.push({
    source: sourceName,
    sourceWidth: sourceMetadata.width,
    sourceHeight: sourceMetadata.height,
    sourceOrientation: sourceMetadata.orientation ?? null,
    sourceBytes: sourceDetails.size,
    output: filename,
    outputWidth: outputMetadata.width,
    outputHeight: outputMetadata.height,
    outputBytes: outputDetails.size,
    sha256,
  });
  await writeJsonAtomic(checkpointFile, checkpoint);
  processed += 1;
  console.log(
    `${checkpoint.items.length}/${sourceNames.length} ${sourceName} -> ${outputMetadata.width}x${outputMetadata.height} ${outputDetails.size}`,
  );
}

if (checkpoint.items.length === sourceNames.length) {
  checkpoint.items.sort(
    (left, right) => sourceNames.indexOf(left.source) - sourceNames.indexOf(right.source),
  );
  const inventory = {
    profile: {
      format: "webp",
      quality: 88,
      effort: 4,
      frameWidth: 1280,
      frameHeight: 800,
      fit: "outside",
      autoOrient: true,
    },
    sourceBytes: checkpoint.items.reduce((total, item) => total + item.sourceBytes, 0),
    outputBytes: checkpoint.items.reduce((total, item) => total + item.outputBytes, 0),
    items: checkpoint.items,
  };
  const media = checkpoint.items.map((item, index) => ({
    id: `local-${item.sha256.slice(0, 16)}`,
    kind: "photo",
    url: `/media/${item.output}`,
    posterUrl: null,
    caption: path.parse(item.source).name,
    senderName: "Prueba local",
    receivedAt: new Date(Date.parse(checkpoint.generatedAt) - index * 1_000).toISOString(),
    fitMode: "inherit",
    durationSeconds: null,
    sha256: item.sha256,
    sizeBytes: item.outputBytes,
  }));
  const manifest = {
    schemaVersion: 1,
    frameId: "local-pilot-rpi-01",
    version: 1,
    publishedAt: checkpoint.generatedAt,
    settings: {
      photoDurationSeconds: 30,
      fadeDurationMs: 450,
      defaultFitMode: "contain",
      order: "newest",
      volume: 0.5,
      muted: false,
      showCaption: true,
      showSender: true,
    },
    media,
  };
  await Promise.all([
    writeJsonAtomic(path.join(target, "inventario.json"), inventory),
    writeJsonAtomic(path.join(target, "manifest.json"), manifest),
  ]);
  await rm(checkpointFile, { force: true });
  console.log(`Conversión completa: ${sourceNames.length} fotografías.`);
}

async function readCheckpoint(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return { generatedAt: new Date().toISOString(), items: [] };
  }
}

async function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, file);
}
