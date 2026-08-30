import { afterEach, describe, expect, it, vi } from "vitest";

import { ServerConfig } from "../src/config.js";
import { AutomaticLocation, GeoLocator } from "../src/geo-location.js";
import { FrameWeatherRecord, Repository } from "../src/repository.js";
import { WeatherService } from "../src/weather.js";

afterEach(() => vi.unstubAllGlobals());

describe("clima central", () => {
  it("detecta la ubicación sin bloquear y conserva una respuesta normalizada", async () => {
    const location: AutomaticLocation = {
      label: "Trujillo, La Libertad, PE",
      city: "Trujillo",
      subdivision: "La Libertad",
      countryCode: "PE",
      latitude: -8.1116,
      longitude: -79.0287,
      timezone: "America/Lima",
      accuracyRadiusKm: 20,
    };
    let record: FrameWeatherRecord = {
      location: null,
      weather: null,
      lastError: null,
    };
    const repository = {
      saveAutomaticLocation: vi.fn(async () => {
        record = { ...record, location: { ...location, source: "maxmind" } };
      }),
      getFrameWeather: vi.fn(async () => record),
      recordWeatherSuccess: vi.fn(async (_frameId: string, weather) => {
        record = { ...record, weather, lastError: null };
      }),
      recordWeatherFailure: vi.fn(),
    } as unknown as Repository;
    const locator: GeoLocator = {
      locate: vi.fn(() => location),
      countryCode: vi.fn(() => "PE"),
    };
    const fetchMock = vi.fn(async () =>
      Response.json({
        current: {
          time: "2026-08-30T01:30",
          temperature_2m: 24.1,
          apparent_temperature: 24.8,
          weather_code: 2,
          is_day: 0,
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const config = {
      weatherApiUrl: "https://api.open-meteo.test/v1/forecast",
      weatherRefreshMs: 900_000,
      weatherStaleMs: 21_600_000,
      weatherFailureCooldownMs: 300_000,
      externalRequestTimeoutMs: 8_000,
      externalRetryCount: 3,
      geoLocationMaxAccuracyRadiusKm: 100,
    } as ServerConfig;
    const logger = { warn: vi.fn() } as never;
    const service = new WeatherService(config, repository, locator, null, logger);

    expect(await service.snapshot("frame-1", "181.1.2.3")).toMatchObject({
      status: "pending",
      location: { label: location.label },
      current: null,
    });
    await vi.waitFor(() => expect(repository.recordWeatherSuccess).toHaveBeenCalledOnce());
    expect(await service.snapshot("frame-1", "181.1.2.3")).toMatchObject({
      status: "ready",
      current: {
        temperatureC: 24.1,
        apparentTemperatureC: 24.8,
        weatherCode: 2,
        isDay: false,
      },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("temperature_2m");
  });

  it("respeta una ubicación manual también durante un refresco Wi-Fi", async () => {
    const manual: AutomaticLocation & { source: "manual" } = {
      label: "Ubicación elegida",
      city: "Trujillo",
      subdivision: "La Libertad",
      countryCode: "PE",
      latitude: -8.12,
      longitude: -79.03,
      timezone: "America/Lima",
      accuracyRadiusKm: null,
      source: "manual",
    };
    const detected: AutomaticLocation = {
      ...manual,
      label: "Ubicación automática por Wi-Fi, PE",
      latitude: -12.05,
      longitude: -77.04,
      accuracyRadiusKm: 0.05,
    };
    let record: FrameWeatherRecord = {
      location: manual,
      weather: null,
      lastError: null,
    };
    const repository = {
      expireGoogleLocation: vi.fn(),
      saveAutomaticLocation: vi.fn(),
      getFrameWeather: vi.fn(async () => record),
      recordWeatherSuccess: vi.fn(async (_frameId: string, weather) => {
        record = { ...record, weather };
      }),
      recordWeatherFailure: vi.fn(),
    } as unknown as Repository;
    const locator: GeoLocator = {
      locate: vi.fn(() => detected),
      countryCode: vi.fn(() => "PE"),
    };
    const wifiLocator = { resolve: vi.fn(async () => detected) };
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("latitude")).toBe(String(manual.latitude));
      expect(url.searchParams.get("longitude")).toBe(String(manual.longitude));
      return Response.json({
        current: {
          time: "2026-08-30T04:00",
          temperature_2m: 20.2,
          apparent_temperature: 22.9,
          weather_code: 1,
          is_day: 0,
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const config = {
      googleGeolocationApiKey: "secret",
      weatherApiUrl: "https://api.open-meteo.test/v1/forecast",
      weatherRefreshMs: 900_000,
      weatherStaleMs: 21_600_000,
      weatherFailureCooldownMs: 300_000,
      locationRefreshMs: 86_400_000,
      locationFailureCooldownMs: 3_600_000,
      externalRequestTimeoutMs: 8_000,
      externalRetryCount: 3,
    } as ServerConfig;
    const service = new WeatherService(
      config,
      repository,
      locator,
      wifiLocator,
      { warn: vi.fn() } as never,
    );

    await service.snapshot("frame-1", "181.1.2.3", [
      { macAddress: "00:11:22:33:44:55" },
      { macAddress: "10:21:32:43:54:65" },
    ]);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  });
});
