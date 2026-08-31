import { describe, expect, it } from "vitest";

import {
  resolveFrameNotification,
  upsertFrameNotification,
} from "../src/notifications.js";

describe("notificaciones del marco", () => {
  it("reabre una notificación deduplicada para que vuelva a ser visible", async () => {
    const statements: Array<{ sql: string; values?: unknown[] }> = [];
    const database = {
      async query(sql: string, values?: unknown[]) {
        statements.push({ sql, values });
        return {
          rows: [{ id: "dc3c227d-594e-4a88-ad4c-3ef330394127" }],
          rowCount: 1,
        };
      },
    };

    const id = await upsertFrameNotification(database, {
      frameId: "11111111-1111-4111-8111-111111111111",
      kind: "storage.capacity.blocked",
      severity: "error",
      title: "Almacenamiento casi lleno",
      message: "Libera espacio.",
      dedupeKey: "storage-capacity",
    });

    expect(id).toBe("dc3c227d-594e-4a88-ad4c-3ef330394127");
    expect(statements[0]?.sql).toContain("ON CONFLICT (frame_id, dedupe_key)");
    expect(statements[0]?.sql).toContain("read_at=NULL");
    expect(statements[0]?.values?.[5]).toBe("storage-capacity");
  });

  it("resuelve un aviso operativo y limpia su contador pendiente", async () => {
    const statements: string[] = [];
    const database = {
      async query(sql: string) {
        statements.push(sql);
        return { rows: [], rowCount: 1 };
      },
    };
    expect(
      await resolveFrameNotification(
        database,
        "11111111-1111-4111-8111-111111111111",
        "storage-capacity",
      ),
    ).toBe(true);
    expect(statements[0]).toContain("read_at=COALESCE(read_at, now())");
  });
});
