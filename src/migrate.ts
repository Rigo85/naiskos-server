import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { loadConfig } from "./config.js";
import { createDatabase } from "./db.js";

const config = loadConfig();
const database = createDatabase(config);
const directory = path.resolve("database/migrations");

await database.query(`CREATE TABLE IF NOT EXISTS public.naiskos_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
)`);

for (const name of (await readdir(directory))
  .filter((file) => file.endsWith(".sql"))
  .sort()) {
  const exists = await database.query(
    "SELECT 1 FROM public.naiskos_migrations WHERE name = $1",
    [name],
  );
  if (exists.rowCount) continue;
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    await client.query(await readFile(path.join(directory, name), "utf8"));
    await client.query(
      "INSERT INTO public.naiskos_migrations (name) VALUES ($1)",
      [name],
    );
    await client.query("COMMIT");
    console.log(`Aplicada ${name}`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

await database.end();
