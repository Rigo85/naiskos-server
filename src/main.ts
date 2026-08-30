import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDatabase } from "./db.js";
import { TelegramClient } from "./telegram.js";
import { MediaWorker } from "./worker.js";

const config = loadConfig();
const database = createDatabase(config);
const app = await buildApp(config, database);
const worker = new MediaWorker(config, database, new TelegramClient(config));
await app.listen({ host: config.host, port: config.port });
worker.start();

async function shutdown(signal: string): Promise<void> {
  await worker.stop();
  app.log.info({ signal }, "Deteniendo Naiskos Server");
  await app.close();
  await database.end();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
