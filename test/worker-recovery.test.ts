import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { ServerConfig } from "../src/config.js";
import { MediaWorker } from "../src/worker.js";

describe("recuperación del worker", () => {
  it("devuelve a pending los jobs cuyo lock quedó abandonado", async () => {
    const statements: Array<{ sql: string; values?: unknown[] }> = [];
    const client = {
      async query(sql: string, values?: unknown[]) {
        statements.push({ sql, values });
        if (sql.includes("WITH candidate")) return { rows: [], rowCount: 0 };
        return { rows: [], rowCount: 1 };
      },
      release() {},
    };
    const database = {
      async query(sql: string, values?: unknown[]) {
        statements.push({ sql, values });
        if (sql.includes("Lock abandonado")) {
          return {
            rows: [{ id: "dc3c227d-594e-4a88-ad4c-3ef330394127" }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      },
      async connect() {
        return client;
      },
    } as unknown as Pool;
    const telegram = {
      fileSource: vi.fn(),
      sendMessage: vi.fn(),
    };
    const config = {
      workerIntervalMs: 1_000,
      workerLockTimeoutSeconds: 900,
    } as ServerConfig;
    const worker = new MediaWorker(config, database, telegram);

    expect(await worker.runOnce()).toBe(false);
    const recovery = statements.find(({ sql }) => sql.includes("Lock abandonado"));
    expect(recovery?.values).toEqual([900]);
    expect(recovery?.sql).toContain("status='running'");
  });
});
