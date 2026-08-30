import sharp from "sharp";

import { loadConfig } from "./config.js";
import { createDatabase } from "./db.js";
import { TelegramClient } from "./telegram.js";
import { MediaWorker } from "./worker.js";

const sharpCache = sharp.cache(false);
const sharpConcurrency = sharp.concurrency(1);
console.info(
  JSON.stringify({
    event: "media.worker.started",
    timestamp: new Date().toISOString(),
    pid: process.pid,
    sharpConcurrency,
    sharpCache,
    mallocArenaMax: process.env.MALLOC_ARENA_MAX ?? null,
  }),
);

const config = loadConfig();
const database = createDatabase(config);
const worker = new MediaWorker(config, database, new TelegramClient(config));

worker.start();

async function shutdown(signal: string): Promise<void> {
  console.info(`Deteniendo Naiskos Worker por ${signal}`);
  await worker.stop();
  await database.end();
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
