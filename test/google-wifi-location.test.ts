import { afterEach, describe, expect, it, vi } from "vitest";

import { ServerConfig } from "../src/config.js";
import {
  GoogleWifiLocationProvider,
  normalizeWifiAccessPoints,
} from "../src/google-wifi-location.js";

afterEach(() => vi.unstubAllGlobals());

describe("geolocalización Wi-Fi", () => {
  it("usa las redes sin permitir fallback por IP", async () => {
    const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        considerIp: false,
        wifiAccessPoints: [
          { macAddress: "00:11:22:33:44:55" },
          { macAddress: "10:21:32:43:54:65" },
        ],
      });
      return Response.json({
        location: { lat: -8.1116, lng: -79.0287 },
        accuracy: 42,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new GoogleWifiLocationProvider({
      googleGeolocationApiKey: "secret",
      googleGeolocationApiUrl: "https://google.test/geolocate",
      googleGeolocationMaxAccuracyMeters: 25_000,
      externalRetryCount: 3,
      externalRequestTimeoutMs: 8_000,
    } as ServerConfig);

    await expect(
      provider.resolve(
        [
          { macAddress: "00:11:22:33:44:55" },
          { macAddress: "10:21:32:43:54:65" },
        ],
        "PE",
      ),
    ).resolves.toMatchObject({
      label: "Ubicación automática por Wi-Fi, PE",
      latitude: -8.1116,
      longitude: -79.0287,
      timezone: "America/Lima",
      accuracyRadiusKm: 0.042,
    });
  });

  it("descarta identificadores inválidos, locales y duplicados", () => {
    expect(
      normalizeWifiAccessPoints([
        { macAddress: "00:11:22:33:44:55" },
        { macAddress: "00:11:22:33:44:55" },
        { macAddress: "02:11:22:33:44:55" },
        { macAddress: "invalido" },
        { macAddress: "10:21:32:43:54:65" },
      ]),
    ).toEqual([
      { macAddress: "00:11:22:33:44:55" },
      { macAddress: "10:21:32:43:54:65" },
    ]);
  });
});
