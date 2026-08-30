import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDatabase } from "./db.js";

const config = loadConfig();
const database = createDatabase(config);
const app = await buildApp(config, database);

await app.listen({ host: config.host, port: config.port });

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, "Deteniendo Naiskos API");
  await app.close();
  await database.end();
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
