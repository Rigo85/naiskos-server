import { Pool, PoolClient, QueryResultRow } from "pg";

import { ServerConfig } from "./config.js";

export type Database = Pool;

export function createDatabase(config: ServerConfig): Database {
  return new Pool({
    connectionString: config.databaseUrl,
    max: config.dbPoolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: "naiskos-server",
  });
}

export async function transaction<T>(
  database: Database,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function oneOrNull<T extends QueryResultRow>(rows: T[]): T | null {
  return rows[0] ?? null;
}
