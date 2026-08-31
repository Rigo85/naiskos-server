import sharp from "sharp";

import { loadConfig } from "./config.js";
import { createDatabase } from "./db.js";
import { backfillMediaThumbnails } from "./thumbnail-backfill.js";

const unknown = process.argv.slice(2).filter((argument) => argument !== "--dry-run");
if (unknown.length) throw new Error(`Argumentos desconocidos: ${unknown.join(", ")}`);

sharp.cache(false);
sharp.concurrency(1);
const config = loadConfig();
const database = createDatabase(config);
try {
  const result = await backfillMediaThumbnails(
    config,
    database,
    process.argv.includes("--dry-run"),
  );
  console.info(JSON.stringify({ event: "media.thumbnails.backfilled", ...result }));
} finally {
  await database.end();
}
