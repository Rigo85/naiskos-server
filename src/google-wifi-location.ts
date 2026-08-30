import tzLookup from "tz-lookup";

import { ServerConfig } from "./config.js";
import { fetchExternalWithRetry } from "./external-http.js";
import { AutomaticLocation } from "./geo-location.js";

export interface WifiAccessPoint {
  macAddress: string;
}

export interface WifiLocationProvider {
  resolve(
    accessPoints: WifiAccessPoint[],
    countryCode: string | null,
  ): Promise<AutomaticLocation | null>;
}

export class GoogleWifiLocationProvider implements WifiLocationProvider {
  constructor(private readonly config: ServerConfig) {}

  async resolve(
    accessPoints: WifiAccessPoint[],
    countryCode: string | null,
  ): Promise<AutomaticLocation | null> {
    const apiKey = this.config.googleGeolocationApiKey;
    if (!apiKey || accessPoints.length < 2) return null;
    const url = new URL(this.config.googleGeolocationApiUrl);
    url.searchParams.set("key", apiKey);
    const response = await fetchExternalWithRetry(
      url,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "user-agent": "Naiskos/0.1",
        },
        body: JSON.stringify({
          considerIp: false,
          wifiAccessPoints: accessPoints,
        }),
      },
      {
        retries: this.config.externalRetryCount,
        timeoutMs: this.config.externalRequestTimeoutMs,
      },
    );
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`Google Geolocation respondió HTTP ${response.status}`);
    }
    const result = normalizeGoogleResponse(await response.json());
    if (result.accuracy > this.config.googleGeolocationMaxAccuracyMeters) {
      return null;
    }
    const normalizedCountry = /^[A-Z]{2}$/.test(countryCode ?? "")
      ? countryCode!
      : "ZZ";
    return {
      label: `Ubicación automática por Wi-Fi${normalizedCountry === "ZZ" ? "" : `, ${normalizedCountry}`}`,
      city: null,
      subdivision: null,
      countryCode: normalizedCountry,
      latitude: result.latitude,
      longitude: result.longitude,
      timezone: tzLookup(result.latitude, result.longitude),
      accuracyRadiusKm: result.accuracy / 1_000,
    };
  }
}

export function normalizeWifiAccessPoints(value: unknown): WifiAccessPoint[] {
  if (!Array.isArray(value)) return [];
  const unique = new Set<string>();
  for (const item of value.slice(0, 50)) {
    if (!item || typeof item !== "object") continue;
    const raw = (item as { macAddress?: unknown }).macAddress;
    if (typeof raw !== "string") continue;
    const macAddress = raw.trim().toUpperCase();
    if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(macAddress)) continue;
    const firstOctet = Number.parseInt(macAddress.slice(0, 2), 16);
    if ((firstOctet & 0x03) !== 0) continue;
    unique.add(macAddress);
    if (unique.size >= 20) break;
  }
  return [...unique].map((macAddress) => ({ macAddress }));
}

function normalizeGoogleResponse(value: unknown): {
  latitude: number;
  longitude: number;
  accuracy: number;
} {
  if (!value || typeof value !== "object") {
    throw new Error("Google Geolocation entregó una respuesta inválida");
  }
  const input = value as { location?: unknown; accuracy?: unknown };
  const location = input.location as { lat?: unknown; lng?: unknown } | undefined;
  const latitude = Number(location?.lat);
  const longitude = Number(location?.lng);
  const accuracy = Number(input.accuracy);
  if (
    !Number.isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90 ||
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180 ||
    !Number.isFinite(accuracy) ||
    accuracy < 0
  ) {
    throw new Error("Google Geolocation entregó coordenadas incompletas");
  }
  return { latitude, longitude, accuracy };
}
