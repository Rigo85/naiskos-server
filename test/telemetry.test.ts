import { describe, expect, it } from "vitest";

import { parseFullTelemetry, parseHeartbeat } from "../src/telemetry.js";

const frameId = "11111111-1111-4111-8111-111111111111";

const full = {
  schemaVersion: 1,
  kind: "full",
  frameId,
  observedAt: "2026-08-31T23:55:00.000Z",
  uptimeSeconds: 100,
  thermal: { temperatureCelsius: 51.2, throttledMask: "0x0" },
  memory: { totalBytes: 1000, usedBytes: 400, availableBytes: 600, swapTotalBytes: 100, swapUsedBytes: 0 },
  storage: { totalBytes: 1000, usedBytes: 300, availableBytes: 700, frameDataBytes: 200, mediaDataBytes: 190, usedPercent: 30 },
  services: { agent: "active", chromium: "active", kioskLauncher: "active" },
  sync: { state: "idle", desiredManifestVersion: 8, installedManifestVersion: 8, pendingOutbox: 0, lastSuccessAt: "2026-08-31T23:55:00.000Z", lastErrorCode: null },
  software: { releaseId: "release-1", agentVersion: "release-1", viewerVersion: "release-1", baselineVersion: "2", nodeVersion: "v24.18.1", chromiumVersion: "151", osVersion: "Debian 13", kernelVersion: "6.18" },
  display: { connected: true, connector: "HDMI-A-1", width: 1280, height: 800, power: "on" },
  audio: { available: true, transport: "hdmi" },
  clock: { synchronized: true, timezone: "America/Lima" },
};

describe("contrato de telemetría", () => {
  it("acepta heartbeat y muestra completa válidos", () => {
    expect(parseHeartbeat({
      schemaVersion: 1,
      kind: "heartbeat",
      observedAt: full.observedAt,
      uptimeSeconds: 100,
      agentState: "ready",
      installedManifestVersion: 8,
      lastSyncAt: full.observedAt,
      lastErrorCode: null,
    })).not.toBeNull();
    expect(parseFullTelemetry(full, frameId)).not.toBeNull();
  });

  it("rechaza otro marco y porcentajes imposibles", () => {
    expect(parseFullTelemetry({ ...full, frameId: crypto.randomUUID() }, frameId)).toBeNull();
    expect(parseFullTelemetry({ ...full, storage: { ...full.storage, usedPercent: 101 } }, frameId)).toBeNull();
  });
});
