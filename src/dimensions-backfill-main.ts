import { parseArgs } from "node:util";
import sharp from "sharp";
import { loadConfig } from "./config.js";
import { createDatabase } from "./db.js";
import { backfillMediaDimensions } from "./dimensions-backfill.js";

const { values } = parseArgs({
  options: {
    "frame-id": { type: "string" },
    apply: { type: "boolean", default: false },
  },
  strict: true,
});
if (!/^[a-f0-9-]{36}$/i.test(values["frame-id"] ?? ""))
  throw new Error(
    "--frame-id UUID es obligatorio; sin --apply sólo se inspecciona.",
  );
sharp.cache(false);
sharp.concurrency(1);
const config = loadConfig();
const database = createDatabase(config);
try {
  console.info(
    JSON.stringify({
      event: "media.dimensions.backfill",
      ...(await backfillMediaDimensions(
        database,
        config.storageRoot,
        values["frame-id"]!,
        values.apply,
      )),
    }),
  );
} finally {
  await database.end();
}
