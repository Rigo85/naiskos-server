import { access } from "node:fs/promises";
import maxmind, { CityResponse, Reader } from "maxmind";

export interface AutomaticLocation {
  label: string;
  city: string | null;
  subdivision: string | null;
  countryCode: string;
  latitude: number;
  longitude: number;
  timezone: string;
  accuracyRadiusKm: number | null;
}

export interface GeoLocator {
  locate(ip: string): AutomaticLocation | null;
  countryCode(ip: string): string | null;
}

export class MaxMindGeoLocator implements GeoLocator {
  private constructor(private readonly reader: Reader<CityResponse>) {}

  static async open(databasePath: string): Promise<MaxMindGeoLocator | null> {
    try {
      await access(databasePath);
      const reader = await maxmind.open<CityResponse>(databasePath, {
        watchForUpdates: true,
      });
      return new MaxMindGeoLocator(reader);
    } catch {
      return null;
    }
  }

  locate(rawIp: string): AutomaticLocation | null {
    const ip = normalizeIp(rawIp);
    if (!maxmind.validate(ip)) return null;
    const match = this.reader.get(ip);
    const location = match?.location;
    const countryCode = match?.country?.iso_code ?? match?.registered_country?.iso_code;
    const timezone = location?.time_zone;
    if (
      !location ||
      !countryCode ||
      !timezone ||
      !Number.isFinite(location.latitude) ||
      !Number.isFinite(location.longitude)
    ) {
      return null;
    }
    const city = localizedName(match.city?.names);
    const subdivision = localizedName(match.subdivisions?.[0]?.names);
    return {
      label: [city, subdivision, countryCode].filter(Boolean).join(", "),
      city,
      subdivision,
      countryCode,
      latitude: location.latitude,
      longitude: location.longitude,
      timezone,
      accuracyRadiusKm: Number.isFinite(location.accuracy_radius)
        ? location.accuracy_radius
        : null,
    };
  }

  countryCode(rawIp: string): string | null {
    const ip = normalizeIp(rawIp);
    if (!maxmind.validate(ip)) return null;
    const match = this.reader.get(ip);
    return match?.country?.iso_code ?? match?.registered_country?.iso_code ?? null;
  }
}

function normalizeIp(rawIp: string): string {
  return rawIp.startsWith("::ffff:") ? rawIp.slice(7) : rawIp;
}

function localizedName(
  names: { es?: string; en: string } | undefined,
): string | null {
  return names?.es?.trim() || names?.en?.trim() || null;
}
