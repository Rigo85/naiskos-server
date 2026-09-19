import { parseArgs } from "node:util";
import sharp from "sharp";
import { loadConfig } from "./config.js";
import { createDatabase } from "./db.js";
import { backfillBandColors } from "./band-colors-backfill.js";

const { values } = parseArgs({ options: {
  "frame-id": { type: "string" }, "after-id": { type: "string" },
  apply: { type: "boolean", default: false }, all: { type: "boolean", default: false },
}, strict: true });
const uuid = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
if (!uuid.test(values["frame-id"] ?? "") || (values["after-id"] && !uuid.test(values["after-id"])))
  throw new Error("--frame-id UUID obligatorio; --after-id UUID opcional. Sin --apply sólo se inspecciona.");
sharp.cache(false);
sharp.concurrency(1);
const config = loadConfig();
const database = createDatabase(config);
try {
  let cursor = values["after-id"];
  do {
    const result = await backfillBandColors(database, config.storageRoot, values["frame-id"]!, values.apply, cursor);
    console.info(JSON.stringify({ event: "media.band-colors.backfill", ...result }));
    if (!values.all || result.candidates < 200 || !result.nextCursor) break;
    cursor = result.nextCursor;
  } while (true);
} finally { await database.end(); }
