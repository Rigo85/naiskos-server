import { createHash } from "node:crypto";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createVideoRenditions } from "../dist/video-processing.js";

const source = path.resolve(process.argv[2] ?? "../fotos-prueba");
const target = path.join(source, "procesados-1280x800-h264-aac");
const extensions = /\.(mp4|mov|m4v|mkv|webm|avi)$/i;
const sourceNames = (await readdir(source, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && extensions.test(entry.name))
  .map((entry) => entry.name)
  .sort((left, right) => left.localeCompare(right, "en"));

if (sourceNames.length === 0) {
  throw new Error(`No se encontraron videos en ${source}`);
}

await mkdir(target, { recursive: true });
const items = [];
for (const sourceName of sourceNames) {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "naiskos-video-pilot-"));
  try {
    const input = path.join(source, sourceName);
    const temporaryVideo = path.join(temporaryRoot, "display.mp4");
    const temporaryPoster = path.join(temporaryRoot, "poster.jpg");
    const result = await createVideoRenditions(input, temporaryVideo, temporaryPoster);
    const [video, poster, inputDetails, videoDetails, posterDetails] = await Promise.all([
      readFile(temporaryVideo),
      readFile(temporaryPoster),
      stat(input),
      stat(temporaryVideo),
      stat(temporaryPoster),
    ]);
    const videoSha256 = createHash("sha256").update(video).digest("hex");
    const posterSha256 = createHash("sha256").update(poster).digest("hex");
    const videoName = `${videoSha256}.mp4`;
    const posterName = `${posterSha256}.jpg`;
    await Promise.all([
      installContentAddressed(temporaryVideo, path.join(target, videoName)),
      installContentAddressed(temporaryPoster, path.join(target, posterName)),
    ]);
    items.push({
      source: sourceName,
      sourceBytes: inputDetails.size,
      sourceProbe: result.source,
      output: videoName,
      outputBytes: videoDetails.size,
      outputSha256: videoSha256,
      outputProbe: result.display,
      poster: posterName,
      posterBytes: posterDetails.size,
      posterSha256,
      posterTimestampSeconds: result.posterTimestampSeconds,
    });
    console.log(
      `${sourceName} -> ${result.display.video.displayWidth}x${result.display.video.displayHeight}, ` +
        `${result.display.durationSeconds.toFixed(3)} s, ${videoDetails.size} bytes`,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

const generatedAt = new Date().toISOString();
const inventory = {
  generatedAt,
  profile: {
    container: "mp4",
    videoCodec: "h264",
    pixelFormat: "yuv420p",
    maxWidth: 1280,
    maxHeight: 800,
    preserveFrameRate: true,
    crf: 21,
    preset: "veryfast",
    audioCodec: "aac",
    audioBitRate: 128000,
    audioSampleRate: 48000,
    audioChannels: 2,
    faststart: true,
    maxDurationSeconds: 120,
  },
  sourceBytes: items.reduce((total, item) => total + item.sourceBytes, 0),
  outputBytes: items.reduce(
    (total, item) => total + item.outputBytes + item.posterBytes,
    0,
  ),
  items,
};
const media = items.map((item, index) => ({
  id: `local-video-${item.outputSha256.slice(0, 16)}`,
  kind: "video",
  url: `/media/${item.output}`,
  posterUrl: `/media/${item.poster}`,
  caption: path.parse(item.source).name,
  senderName: "Prueba local",
  receivedAt: new Date(Date.parse(generatedAt) - index * 1_000).toISOString(),
  fitMode: "inherit",
  durationSeconds: item.outputProbe.durationSeconds,
  sha256: item.outputSha256,
  sizeBytes: item.outputBytes,
}));
await Promise.all([
  writeJsonAtomic(path.join(target, "inventario.json"), inventory),
  writeJsonAtomic(path.join(target, "manifest-fragment.json"), { generatedAt, media }),
]);
console.log(`Conversión completa: ${items.length} videos.`);

async function installContentAddressed(sourceFile, destination) {
  try {
    await access(destination);
  } catch {
    const temporary = `${destination}.${process.pid}.tmp`;
    await copyFile(sourceFile, temporary);
    await rename(temporary, destination);
  }
}

async function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}
