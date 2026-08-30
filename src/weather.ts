import { FastifyBaseLogger } from "fastify";

import { ServerConfig } from "./config.js";
import { fetchExternalWithRetry } from "./external-http.js";
import { AutomaticLocation, GeoLocator } from "./geo-location.js";
import {
  WifiAccessPoint,
  WifiLocationProvider,
} from "./google-wifi-location.js";
import { FrameWeatherRecord, Repository } from "./repository.js";

export interface WeatherPayload {
  status: "pending" | "ready" | "stale" | "unavailable";
  location: {
    label: string;
    timezone: string;
    source: "google_wifi" | "maxmind" | "manual" | "telegram";
    accuracyRadiusKm: number | null;
  } | null;
  current: {
    temperatureC: number;
    apparentTemperatureC: number;
    weatherCode: number;
    isDay: boolean;
    observedAt: string;
  } | null;
  fetchedAt: string | null;
  staleAfter: string | null;
  lastError: string | null;
}

interface ProviderReading {
  temperatureC: number;
  apparentTemperatureC: number;
  weatherCode: number;
  isDay: boolean;
  observedAt: string;
  fetchedAt: string;
}

export class WeatherService {
  private readonly refreshes = new Map<string, Promise<ProviderReading>>();
  private readonly providerCache = new Map<
    string,
    { expiresAt: number; reading: ProviderReading }
  >();
  private readonly retryAfterByFrame = new Map<string, number>();
  private readonly frameRefreshes = new Set<string>();
  private readonly geolocateAfterByFrame = new Map<string, number>();
  private readonly locationRefreshes = new Set<string>();

  constructor(
    private readonly config: ServerConfig,
    private readonly repository: Repository,
    private readonly geoLocator: GeoLocator | null,
    private readonly wifiLocator: WifiLocationProvider | null,
    private readonly logger: FastifyBaseLogger,
  ) {}

  async snapshot(
    frameId: string,
    clientIp: string,
    wifiAccessPoints: WifiAccessPoint[] = [],
  ): Promise<WeatherPayload> {
    if (this.wifiLocator) {
      await this.repository.expireGoogleLocation(frameId);
    }
    const resolvingWifi = this.maybeResolveWifiLocation(
      frameId,
      clientIp,
      wifiAccessPoints,
    );
    if (
      !this.wifiLocator &&
      this.geoLocator &&
      (this.geolocateAfterByFrame.get(frameId) ?? 0) <= Date.now()
    ) {
      const detected = this.geoLocator.locate(clientIp);
      const usable =
        detected &&
        detected.city &&
        detected.accuracyRadiusKm !== null &&
        detected.accuracyRadiusKm <= this.config.geoLocationMaxAccuracyRadiusKm;
      if (usable) {
        await this.repository.saveAutomaticLocation(frameId, detected, "maxmind");
        this.geolocateAfterByFrame.set(
          frameId,
          Date.now() + this.config.weatherRefreshMs,
        );
      } else {
        this.geolocateAfterByFrame.set(
          frameId,
          Date.now() + this.config.weatherFailureCooldownMs,
        );
      }
    }
    const record = await this.repository.getFrameWeather(frameId);
    if (!record?.location) {
      return {
        status: resolvingWifi ? "pending" : "unavailable",
        location: null,
        current: null,
        fetchedAt: null,
        staleAfter: null,
        lastError: resolvingWifi
          ? null
          : this.wifiLocator && wifiAccessPoints.length < 2
            ? "Se necesitan al menos dos puntos Wi-Fi visibles"
            : this.wifiLocator
              ? "No se pudo determinar la ubicación por Wi-Fi"
              : this.geoLocator
                ? "No se pudo determinar una ubicación utilizable"
                : "GeoLite2 City no está disponible",
      };
    }

    const fetchedAt = record.weather?.fetchedAt
      ? Date.parse(record.weather.fetchedAt)
      : Number.NaN;
    if (
      !Number.isFinite(fetchedAt) ||
      Date.now() - fetchedAt >= this.config.weatherRefreshMs
    ) {
      this.triggerRefresh(frameId, record.location);
    }
    return this.toPayload(record);
  }

  private maybeResolveWifiLocation(
    frameId: string,
    clientIp: string,
    accessPoints: WifiAccessPoint[],
  ): boolean {
    if (!this.wifiLocator || accessPoints.length < 2) return false;
    if (
      this.locationRefreshes.has(frameId) ||
      (this.geolocateAfterByFrame.get(frameId) ?? 0) > Date.now()
    ) {
      return this.locationRefreshes.has(frameId);
    }
    this.locationRefreshes.add(frameId);
    const countryCode = this.geoLocator?.countryCode(clientIp) ?? null;
    void this.wifiLocator
      .resolve(accessPoints, countryCode)
      .then(async (location) => {
        if (!location) {
          this.geolocateAfterByFrame.set(
            frameId,
            Date.now() + this.config.locationFailureCooldownMs,
          );
          return;
        }
        await this.repository.saveAutomaticLocation(
          frameId,
          location,
          "google_wifi",
        );
        this.geolocateAfterByFrame.set(
          frameId,
          Date.now() + this.config.locationRefreshMs,
        );
        const stored = await this.repository.getFrameWeather(frameId);
        if (stored?.location) this.triggerRefresh(frameId, stored.location);
      })
      .catch((error) => {
        const detail = error instanceof Error ? error.message : String(error);
        this.geolocateAfterByFrame.set(
          frameId,
          Date.now() + this.config.locationFailureCooldownMs,
        );
        this.logger.warn(
          { frameId, error: detail },
          "Geolocalización Wi-Fi fallida",
        );
      })
      .finally(() => this.locationRefreshes.delete(frameId));
    return true;
  }

  private triggerRefresh(frameId: string, location: AutomaticLocation): void {
    if (this.frameRefreshes.has(frameId)) return;
    if ((this.retryAfterByFrame.get(frameId) ?? 0) > Date.now()) return;
    this.frameRefreshes.add(frameId);
    const key = locationKey(location);
    const cached = this.providerCache.get(key);
    const providerPromise =
      cached && cached.expiresAt > Date.now()
        ? Promise.resolve(cached.reading)
        : this.refreshes.get(key) ?? this.fetchWeather(location, key);

    void providerPromise
      .then(async (reading) => {
        await this.repository.recordWeatherSuccess(frameId, reading);
        this.retryAfterByFrame.delete(frameId);
      })
      .catch(async (error) => {
        const detail = error instanceof Error ? error.message : String(error);
        this.retryAfterByFrame.set(
          frameId,
          Date.now() + this.config.weatherFailureCooldownMs,
        );
        await this.repository.recordWeatherFailure(frameId, detail);
        this.logger.warn({ frameId, error: detail }, "Consulta meteorológica fallida");
      })
      .finally(() => this.frameRefreshes.delete(frameId));
  }

  private fetchWeather(
    location: AutomaticLocation,
    key: string,
  ): Promise<ProviderReading> {
    const promise = this.requestWeather(location)
      .then((reading) => {
        this.providerCache.set(key, {
          expiresAt: Date.now() + this.config.weatherRefreshMs,
          reading,
        });
        return reading;
      })
      .finally(() => this.refreshes.delete(key));
    this.refreshes.set(key, promise);
    return promise;
  }

  private async requestWeather(location: AutomaticLocation): Promise<ProviderReading> {
    const url = new URL(this.config.weatherApiUrl);
    url.searchParams.set("latitude", String(location.latitude));
    url.searchParams.set("longitude", String(location.longitude));
    url.searchParams.set(
      "current",
      "temperature_2m,apparent_temperature,is_day,weather_code",
    );
    url.searchParams.set("temperature_unit", "celsius");
    url.searchParams.set("timezone", "UTC");
    url.searchParams.set("forecast_days", "1");
    const response = await fetchExternalWithRetry(
      url,
      { headers: { accept: "application/json", "user-agent": "Naiskos/0.1" } },
      {
        retries: this.config.externalRetryCount,
        timeoutMs: this.config.externalRequestTimeoutMs,
      },
    );
    if (!response.ok) {
      throw new Error(`Open-Meteo respondió HTTP ${response.status}`);
    }
    return normalizeOpenMeteo(await response.json());
  }

  private toPayload(record: FrameWeatherRecord): WeatherPayload {
    const location = record.location;
    if (!location) {
      return {
        status: "unavailable",
        location: null,
        current: null,
        fetchedAt: null,
        staleAfter: null,
        lastError: record.lastError ?? "Ubicación no disponible",
      };
    }
    const weather = record.weather;
    const fetchedAtMs = weather?.fetchedAt ? Date.parse(weather.fetchedAt) : Number.NaN;
    const staleAfter = Number.isFinite(fetchedAtMs)
      ? new Date(fetchedAtMs + this.config.weatherStaleMs).toISOString()
      : null;
    const stale = staleAfter ? Date.parse(staleAfter) <= Date.now() : false;
    return {
      status: weather ? (stale ? "stale" : "ready") : "pending",
      location: {
        label: location.label,
        timezone: location.timezone,
        source: location.source,
        accuracyRadiusKm: location.accuracyRadiusKm,
      },
      current: weather
        ? {
            temperatureC: weather.temperatureC,
            apparentTemperatureC: weather.apparentTemperatureC,
            weatherCode: weather.weatherCode,
            isDay: weather.isDay,
            observedAt: weather.observedAt,
          }
        : null,
      fetchedAt: weather?.fetchedAt ?? null,
      staleAfter,
      lastError: record.lastError,
    };
  }
}

function normalizeOpenMeteo(value: unknown): ProviderReading {
  if (!value || typeof value !== "object") throw new Error("Respuesta meteorológica inválida");
  const current = (value as { current?: unknown }).current;
  if (!current || typeof current !== "object")
    throw new Error("Open-Meteo no entregó condiciones actuales");
  const input = current as Record<string, unknown>;
  const temperatureC = Number(input.temperature_2m);
  const apparentTemperatureC = Number(input.apparent_temperature);
  const weatherCode = Number(input.weather_code);
  const isDay = Number(input.is_day);
  const observedAt = String(input.time ?? "");
  if (
    !Number.isFinite(temperatureC) ||
    !Number.isFinite(apparentTemperatureC) ||
    !Number.isInteger(weatherCode) ||
    (isDay !== 0 && isDay !== 1) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(observedAt)
  ) {
    throw new Error("Open-Meteo entregó datos incompletos");
  }
  return {
    temperatureC,
    apparentTemperatureC,
    weatherCode,
    isDay: isDay === 1,
    observedAt: new Date(`${observedAt.replace(/Z$/, "")}Z`).toISOString(),
    fetchedAt: new Date().toISOString(),
  };
}

function locationKey(location: AutomaticLocation): string {
  return `${location.latitude.toFixed(3)},${location.longitude.toFixed(3)}`;
}
