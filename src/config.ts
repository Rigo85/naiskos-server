import path from "node:path";

export interface ServerConfig {
  host: string;
  port: number;
  publicUrl: string;
  databaseUrl: string;
  dbPoolMax: number;
  storageRoot: string;
  telegramToken: string | null;
  telegramWebhookSecret: string | null;
  telegramApiBase: string;
  telegramAdminIds: Set<string>;
  deviceBootstrapToken: string | null;
  workerIntervalMs: number;
  workerLockTimeoutSeconds: number;
  originalRetentionDays: number;
  trashRetentionDays: number;
  trustedProxies: string[];
  geoLiteDatabasePath: string;
  googleGeolocationApiKey: string | null;
  googleGeolocationApiUrl: string;
  googleGeolocationMaxAccuracyMeters: number;
  locationRefreshMs: number;
  locationFailureCooldownMs: number;
  weatherApiUrl: string;
  weatherRefreshMs: number;
  weatherStaleMs: number;
  weatherFailureCooldownMs: number;
  externalRequestTimeoutMs: number;
  externalRetryCount: number;
  geoLocationMaxAccuracyRadiusKm: number;
}

function integer(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} debe estar entre ${minimum} y ${maximum}`);
  }
  return value;
}

export function loadConfig(): ServerConfig {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL es obligatorio");
  return {
    host: process.env.NAISKOS_HOST ?? "127.0.0.1",
    port: integer("NAISKOS_PORT", 8090, 1, 65_535),
    publicUrl: (
      process.env.NAISKOS_PUBLIC_URL ?? "http://127.0.0.1:8090"
    ).replace(/\/$/, ""),
    databaseUrl,
    dbPoolMax: integer("NAISKOS_DB_POOL_MAX", 10, 1, 10),
    storageRoot: path.resolve(process.env.NAISKOS_STORAGE_ROOT ?? "./storage"),
    telegramToken: process.env.TELEGRAM_BOT_TOKEN ?? null,
    telegramWebhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET ?? null,
    telegramApiBase: (
      process.env.TELEGRAM_API_BASE ?? "https://api.telegram.org"
    ).replace(/\/$/, ""),
    telegramAdminIds: new Set(
      (process.env.TELEGRAM_ADMIN_IDS ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    ),
    deviceBootstrapToken: process.env.NAISKOS_DEVICE_BOOTSTRAP_TOKEN ?? null,
    workerIntervalMs: integer("NAISKOS_WORKER_INTERVAL_MS", 1_000, 250, 60_000),
    workerLockTimeoutSeconds: integer(
      "NAISKOS_WORKER_LOCK_TIMEOUT_SECONDS",
      15 * 60,
      30,
      60 * 60,
    ),
    originalRetentionDays: integer("NAISKOS_ORIGINAL_RETENTION_DAYS", 7, 1, 90),
    trashRetentionDays: integer("NAISKOS_TRASH_RETENTION_DAYS", 30, 1, 365),
    trustedProxies: (process.env.NAISKOS_TRUSTED_PROXIES ?? "127.0.0.1")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    geoLiteDatabasePath: path.resolve(
      process.env.NAISKOS_GEOLITE_DATABASE_PATH ?? "./data/GeoLite2-City.mmdb",
    ),
    googleGeolocationApiKey:
      process.env.GOOGLE_GEOLOCATION_API_KEY?.trim() || null,
    googleGeolocationApiUrl: (
      process.env.NAISKOS_GOOGLE_GEOLOCATION_API_URL ??
      "https://www.googleapis.com/geolocation/v1/geolocate"
    ).replace(/\/$/, ""),
    googleGeolocationMaxAccuracyMeters: integer(
      "NAISKOS_GOOGLE_GEOLOCATION_MAX_ACCURACY_METERS",
      25_000,
      10,
      100_000,
    ),
    locationRefreshMs: integer(
      "NAISKOS_LOCATION_REFRESH_MS",
      24 * 60 * 60_000,
      60 * 60_000,
      30 * 24 * 60 * 60_000,
    ),
    locationFailureCooldownMs: integer(
      "NAISKOS_LOCATION_FAILURE_COOLDOWN_MS",
      60 * 60_000,
      5 * 60_000,
      24 * 60 * 60_000,
    ),
    weatherApiUrl: (
      process.env.NAISKOS_WEATHER_API_URL ?? "https://api.open-meteo.com/v1/forecast"
    ).replace(/\/$/, ""),
    weatherRefreshMs: integer(
      "NAISKOS_WEATHER_REFRESH_MS",
      15 * 60_000,
      5 * 60_000,
      24 * 60 * 60_000,
    ),
    weatherStaleMs: integer(
      "NAISKOS_WEATHER_STALE_MS",
      6 * 60 * 60_000,
      30 * 60_000,
      7 * 24 * 60 * 60_000,
    ),
    weatherFailureCooldownMs: integer(
      "NAISKOS_WEATHER_FAILURE_COOLDOWN_MS",
      5 * 60_000,
      30_000,
      24 * 60 * 60_000,
    ),
    externalRequestTimeoutMs: integer(
      "NAISKOS_EXTERNAL_REQUEST_TIMEOUT_MS",
      8_000,
      1_000,
      60_000,
    ),
    externalRetryCount: integer(
      "NAISKOS_EXTERNAL_RETRY_COUNT",
      3,
      3,
      8,
    ),
    geoLocationMaxAccuracyRadiusKm: integer(
      "NAISKOS_GEOLOCATION_MAX_ACCURACY_RADIUS_KM",
      100,
      1,
      1_000,
    ),
  };
}
