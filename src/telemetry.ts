const AGENT_STATES = new Set([
  "unconfigured",
  "ready",
  "syncing",
  "storage-blocked",
  "offline",
  "error",
]);
const SERVICE_STATES = new Set(["active", "inactive", "failed", "unknown"]);
const SYNC_STATES = new Set(["idle", "checking", "downloading", "error"]);

export interface HeartbeatTelemetry {
  schemaVersion: 1;
  kind: "heartbeat";
  observedAt: string;
  uptimeSeconds: number;
  agentState: string;
  installedManifestVersion: number;
  lastSyncAt: string | null;
  lastErrorCode: string | null;
}

export interface FullTelemetry {
  schemaVersion: 1;
  kind: "full";
  frameId: string;
  observedAt: string;
  uptimeSeconds: number;
  thermal: { temperatureCelsius: number | null; throttledMask: string | null };
  memory: {
    totalBytes: number;
    usedBytes: number;
    availableBytes: number;
    swapTotalBytes: number;
    swapUsedBytes: number;
  };
  storage: {
    totalBytes: number;
    usedBytes: number;
    availableBytes: number;
    frameDataBytes: number;
    mediaDataBytes: number;
    usedPercent: number;
  };
  services: { agent: string; chromium: string; kioskLauncher: string };
  sync: {
    state: string;
    desiredManifestVersion: number;
    installedManifestVersion: number;
    pendingOutbox: number;
    lastSuccessAt: string | null;
    lastErrorCode: string | null;
  };
  software: {
    releaseId: string;
    agentVersion: string;
    viewerVersion: string;
    baselineVersion: string;
    nodeVersion: string;
    chromiumVersion: string;
    osVersion: string;
    kernelVersion: string;
  };
  display: {
    connected: boolean;
    connector: string;
    width: number;
    height: number;
    power: "on" | "off" | "unknown";
  };
  audio: { available: boolean; transport: "hdmi" | "analog" | "usb" | "unknown" };
  clock: { synchronized: boolean; timezone: string };
}

export interface LegacyTelemetry {
  state: string;
  manifestVersion: number;
  diskUsedPercent: number;
  diskTotalBytes?: number;
  diskUsedBytes?: number;
  diskAvailableBytes?: number;
  diskReservedBytes?: number;
  frameDataBytes?: number;
  mediaDataBytes?: number;
  lastError: string | null;
  lastSyncAt: string | null;
}

export function parseHeartbeat(input: unknown): HeartbeatTelemetry | null {
  const value = record(input);
  if (
    value?.schemaVersion !== 1 ||
    value.kind !== "heartbeat" ||
    !dateTime(value.observedAt) ||
    !nonnegativeInteger(value.uptimeSeconds) ||
    typeof value.agentState !== "string" ||
    !AGENT_STATES.has(value.agentState) ||
    !nonnegativeInteger(value.installedManifestVersion) ||
    !nullableDateTime(value.lastSyncAt) ||
    !nullableShortString(value.lastErrorCode, 80)
  ) return null;
  return value as unknown as HeartbeatTelemetry;
}

export function parseFullTelemetry(input: unknown, frameId: string): FullTelemetry | null {
  const value = record(input);
  const thermal = record(value?.thermal);
  const memory = record(value?.memory);
  const storage = record(value?.storage);
  const services = record(value?.services);
  const sync = record(value?.sync);
  const software = record(value?.software);
  const display = record(value?.display);
  const audio = record(value?.audio);
  const clock = record(value?.clock);
  if (
    value?.schemaVersion !== 1 || value.kind !== "full" || value.frameId !== frameId ||
    !dateTime(value.observedAt) || !nonnegativeInteger(value.uptimeSeconds) ||
    !nullableNumber(thermal?.temperatureCelsius, -20, 120) ||
    !nullablePattern(thermal?.throttledMask, /^0x[0-9a-f]+$/i) ||
    !usage(memory) || !storageUsage(storage) ||
    !service(services?.agent) || !service(services?.chromium) || !service(services?.kioskLauncher) ||
    typeof sync?.state !== "string" || !SYNC_STATES.has(sync.state) ||
    !nonnegativeInteger(sync.desiredManifestVersion) ||
    !nonnegativeInteger(sync.installedManifestVersion) || !nonnegativeInteger(sync.pendingOutbox) ||
    !nullableDateTime(sync.lastSuccessAt) || !nullableShortString(sync.lastErrorCode, 80) ||
    !shortStrings(software, ["releaseId", "agentVersion", "viewerVersion", "baselineVersion", "nodeVersion", "chromiumVersion", "osVersion", "kernelVersion"], 120) ||
    typeof display?.connected !== "boolean" || !shortString(display.connector, 40) ||
    !nonnegativeInteger(display.width) || !nonnegativeInteger(display.height) ||
    !["on", "off", "unknown"].includes(String(display.power)) ||
    typeof audio?.available !== "boolean" || !["hdmi", "analog", "usb", "unknown"].includes(String(audio.transport)) ||
    typeof clock?.synchronized !== "boolean" || !shortString(clock.timezone, 80)
  ) return null;
  return value as unknown as FullTelemetry;
}

export function parseLegacyTelemetry(input: unknown): LegacyTelemetry | null {
  const value = record(input);
  if (
    !value || typeof value.state !== "string" || !AGENT_STATES.has(value.state) ||
    !nonnegativeInteger(value.manifestVersion) || !numberRange(value.diskUsedPercent, 0, 100) ||
    !["diskTotalBytes", "diskUsedBytes", "diskAvailableBytes", "diskReservedBytes", "frameDataBytes", "mediaDataBytes"]
      .every((key) => value[key] === undefined || nonnegativeInteger(value[key])) ||
    !(value.lastError === null || typeof value.lastError === "string") || !nullableDateTime(value.lastSyncAt)
  ) return null;
  return value as unknown as LegacyTelemetry;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function nonnegativeInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
function numberRange(value: unknown, minimum: number, maximum: number): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum;
}
function nullableNumber(value: unknown, minimum: number, maximum: number): boolean {
  return value === null || numberRange(value, minimum, maximum);
}
function shortString(value: unknown, length: number): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= length;
}
function nullableShortString(value: unknown, length: number): boolean {
  return value === null || (typeof value === "string" && value.length <= length);
}
function nullablePattern(value: unknown, pattern: RegExp): boolean {
  return value === null || (typeof value === "string" && pattern.test(value));
}
function dateTime(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
function nullableDateTime(value: unknown): boolean {
  return value === null || dateTime(value);
}
function usage(value: Record<string, unknown> | null): boolean {
  return Boolean(value && ["totalBytes", "usedBytes", "availableBytes", "swapTotalBytes", "swapUsedBytes"]
    .every((key) => nonnegativeInteger(value[key])));
}
function storageUsage(value: Record<string, unknown> | null): boolean {
  return Boolean(value && ["totalBytes", "usedBytes", "availableBytes", "frameDataBytes", "mediaDataBytes"]
    .every((key) => nonnegativeInteger(value[key])) && numberRange(value.usedPercent, 0, 100));
}
function service(value: unknown): boolean {
  return typeof value === "string" && SERVICE_STATES.has(value);
}
function shortStrings(value: Record<string, unknown> | null, keys: string[], length: number): boolean {
  return Boolean(value && keys.every((key) => shortString(value[key], length)));
}
