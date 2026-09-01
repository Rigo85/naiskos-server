import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { Repository } from "../src/repository.js";

class FakeClient {
  readonly statements: Array<{ sql: string; values?: unknown[] }> = [];

  async query(sql: string, values?: unknown[]) {
    this.statements.push({ sql, values });
    return { rows: [], rowCount: 1 };
  }

  release(): void {}
}

describe("eventos del dispositivo", () => {
  it("consume IDs de medios heredados sin bloquear los eventos siguientes", async () => {
    const client = new FakeClient();
    const database = {
      connect: async () => client,
    } as unknown as Pool;
    const repository = new Repository(database);
    const frameId = "11111111-1111-4111-8111-111111111111";
    const legacyEventId = "dc3c227d-594e-4a88-ad4c-3ef330394127";
    const settingsEventId = "c34a058f-c1fa-4d9d-89ec-d75a28cff37a";

    const accepted = await repository.applyDeviceEvents(frameId, [
      {
        id: legacyEventId,
        type: "media.fit-mode.updated",
        at: "2026-08-28T18:13:37.716Z",
        mediaId: "local-cb3c5a54911a44a2",
        fitMode: "cover",
      },
      {
        id: settingsEventId,
        type: "settings.updated",
        at: "2026-08-29T16:06:21.715Z",
        settings: { volume: 0.5, muted: true },
      },
    ]);

    expect(accepted).toEqual([legacyEventId, settingsEventId]);
    expect(
      client.statements.some(({ sql }) => sql.includes("UPDATE naiskos.frame_media")),
    ).toBe(false);
    expect(
      client.statements.some(
        ({ sql, values }) =>
          sql.includes("INSERT INTO naiskos.audit_log") &&
          values?.[2] === "media.fit-mode.updated.ignored" &&
          String(values?.[3]).includes("legacy-media-id"),
      ),
    ).toBe(true);
    expect(
      client.statements.some(({ sql }) =>
        sql.includes("UPDATE naiskos.frames SET settings=$2"),
      ),
    ).toBe(true);
    expect(client.statements.at(-1)?.sql).toBe("COMMIT");
  });

  it("elimina sólo la relación del marco y publica un manifiesto nuevo", async () => {
    const client = new FakeClient();
    const repository = new Repository({ connect: async () => client } as unknown as Pool);
    const frameId = "11111111-1111-4111-8111-111111111111";
    const mediaId = "b210a8b6-1a17-4759-af25-2cf1fca0c057";
    const eventId = "c210a8b6-1a17-4759-af25-2cf1fca0c058";

    expect(
      await repository.applyDeviceEvents(frameId, [
        { id: eventId, type: "media.deleted", mediaId },
      ]),
    ).toEqual([eventId]);
    expect(
      client.statements.some(
        ({ sql, values }) =>
          sql.includes("SET deleted_at=now()") &&
          values?.[0] === frameId &&
          values?.[1] === mediaId,
      ),
    ).toBe(true);
    expect(
      client.statements.some(({ sql }) => sql.includes("manifest_version=manifest_version+1")),
    ).toBe(true);
  });

  it("encola una rotación absoluta sin cambiar todavía el manifiesto", async () => {
    class RotationClient extends FakeClient {
      override async query(sql: string, values?: unknown[]) {
        this.statements.push({ sql, values });
        if (sql.includes("SELECT rotation_degrees")) {
          return { rows: [{ rotationDegrees: 0 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }
    }
    const client = new RotationClient();
    const repository = new Repository({ connect: async () => client } as unknown as Pool);
    const frameId = "11111111-1111-4111-8111-111111111111";
    const mediaId = "b210a8b6-1a17-4759-af25-2cf1fca0c057";
    const eventId = "c210a8b6-1a17-4759-af25-2cf1fca0c058";

    await repository.applyDeviceEvents(frameId, [
      { id: eventId, type: "media.rotation.requested", mediaId, rotationDegrees: 90 },
    ]);

    const queued = client.statements.find(({ sql }) =>
      sql.includes("VALUES ($1, 'media.rotate'"),
    );
    expect(String(queued?.values?.[1])).toContain('"rotationDegrees":90');
    expect(
      client.statements.some(({ sql }) => sql.includes("manifest_version=manifest_version+1")),
    ).toBe(false);
  });

  it("persiste lectura y ocultación de notificaciones del mismo marco", async () => {
    const client = new FakeClient();
    const repository = new Repository({ connect: async () => client } as unknown as Pool);
    const frameId = "11111111-1111-4111-8111-111111111111";
    const notificationId = "b210a8b6-1a17-4759-af25-2cf1fca0c057";

    await repository.applyDeviceEvents(frameId, [
      {
        id: "c210a8b6-1a17-4759-af25-2cf1fca0c058",
        type: "notification.read",
        notificationId,
      },
      {
        id: "d210a8b6-1a17-4759-af25-2cf1fca0c059",
        type: "notification.dismissed",
        notificationId,
      },
    ]);

    const notificationUpdates = client.statements.filter(({ sql }) =>
      sql.includes("UPDATE naiskos.frame_notifications"),
    );
    expect(notificationUpdates).toHaveLength(2);
    expect(notificationUpdates[0]?.sql.match(/read_at=/g)).toHaveLength(1);
    expect(notificationUpdates[0]?.values).toEqual([notificationId, frameId]);
    expect(notificationUpdates[1]?.sql).toContain("dismissed_at=COALESCE");
    expect(notificationUpdates[1]?.sql.match(/read_at=/g)).toHaveLength(1);
  });

  it("abre y recupera alertas del horario de pantalla", async () => {
    class DisplayClient extends FakeClient {
      override async query(sql: string, values?: unknown[]) {
        this.statements.push({ sql, values });
        if (sql.includes("SELECT name FROM naiskos.frames")) {
          return { rows: [{ name: "Piloto" }], rowCount: 1 };
        }
        if (sql.includes("SELECT resolved_at IS NULL AS active")) {
          return {
            rows: values?.[1] === "display-wake-failed"
              ? [{ active: false }]
              : [{ active: true }],
            rowCount: 1,
          };
        }
        if (sql.includes("INSERT INTO naiskos.frame_notifications")) {
          return {
            rows: [{ id: "e210a8b6-1a17-4759-af25-2cf1fca0c060" }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 1 };
      }
    }
    const client = new DisplayClient();
    const repository = new Repository(
      { connect: async () => client } as unknown as Pool,
    );
    const frameId = "11111111-1111-4111-8111-111111111111";
    const transitions: import("../src/repository.js").TelemetryAlertTransition[] = [];

    await repository.applyDeviceEvents(
      frameId,
      [
        {
          id: "c210a8b6-1a17-4759-af25-2cf1fca0c058",
          type: "display.wake.failed",
          attempts: 6,
        },
        {
          id: "d210a8b6-1a17-4759-af25-2cf1fca0c059",
          type: "display.sleep.succeeded",
          attempts: 1,
        },
      ],
      transitions,
    );

    expect(transitions).toMatchObject([
      {
        frameName: "Piloto",
        status: "opened",
        kind: "schedule.display.wake",
        severity: "error",
      },
      {
        frameName: "Piloto",
        status: "resolved",
        kind: "schedule.display.sleep",
        severity: "info",
      },
    ]);
    expect(
      client.statements.some(
        ({ sql, values }) =>
          sql.includes("INSERT INTO naiskos.frame_notifications") &&
          values?.includes("display-wake-failed"),
      ),
    ).toBe(true);
    expect(
      client.statements.some(({ sql }) =>
        sql.includes("UPDATE naiskos.frame_notifications") &&
        sql.includes("resolved_at=COALESCE(resolved_at, now())"),
      ),
    ).toBe(true);
  });
});
