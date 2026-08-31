import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import Fastify, { FastifyInstance, FastifyRequest } from "fastify";

import { ServerConfig } from "./config.js";
import { Database } from "./db.js";
import { MaxMindGeoLocator } from "./geo-location.js";
import {
  GoogleWifiLocationProvider,
  normalizeWifiAccessPoints,
} from "./google-wifi-location.js";
import { Repository } from "./repository.js";
import { verifyOpaqueSecret, verifyWebhookSecret } from "./security.js";
import { TelegramClient, TelegramHandler, TelegramUpdate } from "./telegram.js";
import { WeatherService } from "./weather.js";

export async function buildApp(
  config: ServerConfig,
  database: Database,
): Promise<FastifyInstance> {
  const privacyPolicy = await readFile(
    new URL("../docs/privacy-policy-es.html", import.meta.url),
    "utf8",
  );
  const app = Fastify({
    logger: true,
    trustProxy: config.trustedProxies,
    bodyLimit: 2 * 1024 * 1024,
  });
  const repository = new Repository(database);
  const telegram = new TelegramClient(config);
  const telegramHandler = new TelegramHandler(config, repository, telegram);
  const geoLocator = await MaxMindGeoLocator.open(config.geoLiteDatabasePath);
  const wifiLocator = config.googleGeolocationApiKey
    ? new GoogleWifiLocationProvider(config)
    : null;
  const weather = new WeatherService(
    config,
    repository,
    geoLocator,
    wifiLocator,
    app.log,
  );
  if (!geoLocator) {
    app.log.warn(
      { databasePath: config.geoLiteDatabasePath },
      "GeoLite2 City no está disponible; clima automático pendiente",
    );
  }

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("cache-control", "no-store");
    return payload;
  });

  app.get("/health", async (_request, reply) => {
    try {
      await database.query("SELECT 1");
      return { ok: true, database: "ready" };
    } catch {
      return reply.code(503).send({ ok: false, database: "unavailable" });
    }
  });

  app.get("/privacidad", async (_request, reply) =>
    reply.type("text/html; charset=utf-8").send(privacyPolicy),
  );

  app.post<{
    Body: {
      hardwareFingerprint?: string;
      tokenHash?: string;
      pairingCodeHash?: string;
      deviceModel?: string;
      suggestedName?: string;
      width?: number;
      height?: number;
    };
  }>("/api/v1/provisioning/automatic", async (request, reply) => {
    if (
      !verifyOpaqueSecret(
        rawBearerToken(request) ?? undefined,
        config.deviceBootstrapToken,
      )
    ) {
      return reply.code(401).send({ error: "Registro automático no autorizado" });
    }
    const body = request.body;
    const deviceModel = normalizeShortText(body?.deviceModel, 120);
    const suggestedName = normalizeShortText(body?.suggestedName, 120);
    const hardwareFingerprint = decodeSha256(body?.hardwareFingerprint);
    const agentTokenHash = decodeSha256(body?.tokenHash);
    const pairingCodeHash = decodeSha256(body?.pairingCodeHash);
    if (
      !deviceModel ||
      !suggestedName ||
      !hardwareFingerprint ||
      !agentTokenHash ||
      !pairingCodeHash ||
      !validDimension(body?.width) ||
      !validDimension(body?.height)
    ) {
      return reply.code(400).send({ error: "Registro automático inválido" });
    }
    const result = await repository.automaticallyEnrollDevice({
      hardwareFingerprint,
      tokenHash: agentTokenHash,
      pairingCodeHash,
      deviceModel,
      suggestedName,
      width: body.width,
      height: body.height,
    });
    return reply.code(result.created ? 201 : 200).send(result);
  });

  app.post<{
    Body: {
      requestId?: string;
      hardwareFingerprint?: string;
      tokenHash?: string;
      claimCodeHash?: string;
      deviceModel?: string;
      suggestedName?: string;
      width?: number;
      height?: number;
    };
  }>("/api/v1/provisioning/enrollments", async (request, reply) => {
    const body = request.body;
    const requestId = body?.requestId;
    const deviceModel = normalizeShortText(body?.deviceModel, 120);
    const suggestedName = normalizeShortText(body?.suggestedName, 120);
    const hardwareFingerprint = decodeSha256(body?.hardwareFingerprint);
    const enrollmentTokenHash = decodeSha256(body?.tokenHash);
    const claimCodeHash = decodeSha256(body?.claimCodeHash);
    if (
      !requestId ||
      !isUuid(requestId) ||
      !deviceModel ||
      !suggestedName ||
      !hardwareFingerprint ||
      !enrollmentTokenHash ||
      !claimCodeHash ||
      !validDimension(body?.width) ||
      !validDimension(body?.height)
    ) {
      return reply.code(400).send({ error: "Solicitud de alta inválida" });
    }
    const result = await repository.createDeviceEnrollment({
      requestId,
      hardwareFingerprint,
      tokenHash: enrollmentTokenHash,
      claimCodeHash,
      deviceModel,
      suggestedName,
      width: body.width,
      height: body.height,
    });
    if (result.status === "already_enrolled") {
      return reply.code(409).send({ error: "El dispositivo ya está registrado" });
    }
    if (result.status === "missing") {
      return reply.code(409).send({ error: "Existe otra solicitud de alta" });
    }
    return reply.code(result.changed ? 201 : 200).send({
      requestId,
      status: result.status,
    });
  });

  app.get<{ Params: { requestId: string } }>(
    "/api/v1/provisioning/enrollments/:requestId",
    async (request, reply) => {
      if (!isUuid(request.params.requestId)) {
        return reply.code(404).send({ error: "Solicitud no encontrada" });
      }
      const token = bearerToken(request);
      if (!token) return reply.code(401).send({ error: "No autorizado" });
      const enrollment = await repository.getDeviceEnrollment(
        request.params.requestId,
        token,
      );
      if (!enrollment)
        return reply.code(401).send({ error: "No autorizado" });
      return enrollment;
    },
  );

  app.post<{ Body: TelegramUpdate }>(
    "/webhooks/telegram",
    async (request, reply) => {
      const secret = request.headers["x-telegram-bot-api-secret-token"];
      if (
        !verifyWebhookSecret(
          Array.isArray(secret) ? secret[0] : secret,
          config.telegramWebhookSecret,
        )
      ) {
        return reply.code(401).send({ error: "Webhook no autorizado" });
      }
      if (!Number.isSafeInteger(request.body?.update_id))
        return reply.code(400).send({ error: "update_id inválido" });
      if (!(await repository.claimTelegramUpdate(request.body.update_id)))
        return { ok: true, duplicate: true };
      try {
        await telegramHandler.handle(request.body);
        await repository.completeTelegramUpdate(request.body.update_id);
      } catch (error) {
        await repository.releaseTelegramUpdate(request.body.update_id);
        throw error;
      }
      return { ok: true };
    },
  );

  app.get<{ Params: { frameId: string } }>(
    "/api/v1/frames/:frameId/manifest",
    async (request, reply) => {
      const frame = await authenticatedFrame(request, repository);
      if (!frame || frame.id !== request.params.frameId)
        return reply.code(401).send({ error: "No autorizado" });
      const manifest = await repository.getManifest(frame.id, config.publicUrl);
      const etag = `"${String(manifest.version)}"`;
      if (request.headers["if-none-match"] === etag)
        return reply.code(304).send();
      reply.header("etag", etag);
      return manifest;
    },
  );

  app.get<{ Params: { frameId: string } }>(
    "/api/v1/frames/:frameId/weather",
    async (request, reply) => {
      const frame = await authenticatedFrame(request, repository);
      if (!frame || frame.id !== request.params.frameId)
        return reply.code(401).send({ error: "No autorizado" });
      return weather.snapshot(frame.id, request.ip);
    },
  );

  app.get<{ Params: { frameId: string } }>(
    "/api/v1/frames/:frameId/notifications",
    async (request, reply) => {
      const frame = await authenticatedFrame(request, repository);
      if (!frame || frame.id !== request.params.frameId)
        return reply.code(401).send({ error: "No autorizado" });
      return { notifications: await repository.getNotifications(frame.id) };
    },
  );

  app.post<{
    Params: { frameId: string };
    Body: { wifiAccessPoints?: unknown };
  }>("/api/v1/frames/:frameId/weather", async (request, reply) => {
    const frame = await authenticatedFrame(request, repository);
    if (!frame || frame.id !== request.params.frameId)
      return reply.code(401).send({ error: "No autorizado" });
    const wifiAccessPoints = normalizeWifiAccessPoints(
      request.body?.wifiAccessPoints,
    );
    return weather.snapshot(frame.id, request.ip, wifiAccessPoints);
  });

  app.put<{
    Params: { frameId: string };
    Body: { pairingCodeHash?: string };
  }>("/api/v1/frames/:frameId/pairing-code", async (request, reply) => {
    const frame = await authenticatedFrame(request, repository);
    if (!frame || frame.id !== request.params.frameId)
      return reply.code(401).send({ error: "No autorizado" });
    const codeHash = decodeSha256(request.body?.pairingCodeHash);
    if (!codeHash)
      return reply.code(400).send({ error: "Código de vinculación inválido" });
    await repository.setFramePairingCode(frame.id, codeHash);
    return reply.code(204).send();
  });

  app.get<{ Params: { variantId: string } }>(
    "/api/v1/files/:variantId",
    async (request, reply) => {
      const frame = await authenticatedFrame(request, repository);
      if (!frame) return reply.code(401).send({ error: "No autorizado" });
      const variant = await repository.variantForFrame(
        frame.id,
        request.params.variantId,
      );
      if (!variant)
        return reply.code(404).send({ error: "Archivo no encontrado" });
      const root = path.resolve(config.storageRoot);
      const file = path.resolve(root, variant.storagePath);
      if (!file.startsWith(`${root}${path.sep}`))
        return reply.code(500).send({ error: "Ruta inválida" });
      const details = await stat(file);
      const range = parseRange(request.headers.range, details.size);
      reply.header("accept-ranges", "bytes");
      if (range) {
        reply.code(206);
        reply.header(
          "content-range",
          `bytes ${range.start}-${range.end}/${details.size}`,
        );
        reply.header("content-length", String(range.end - range.start + 1));
        return reply.type(variant.mimeType).send(createReadStream(file, range));
      }
      reply.header("content-length", String(details.size));
      return reply.type(variant.mimeType).send(createReadStream(file));
    },
  );

  app.post<{
    Params: { frameId: string };
    Body: { events?: Array<Record<string, unknown>> };
  }>("/api/v1/frames/:frameId/events", async (request, reply) => {
    const frame = await authenticatedFrame(request, repository);
    if (!frame || frame.id !== request.params.frameId)
      return reply.code(401).send({ error: "No autorizado" });
    if (!Array.isArray(request.body?.events))
      return reply.code(400).send({ error: "events inválido" });
    return {
      accepted: await repository.applyDeviceEvents(
        frame.id,
        request.body.events,
      ),
    };
  });

  app.post<{
    Params: { frameId: string };
    Body: {
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
    };
  }>("/api/v1/frames/:frameId/telemetry", async (request, reply) => {
    const frame = await authenticatedFrame(request, repository);
    if (!frame || frame.id !== request.params.frameId)
      return reply.code(401).send({ error: "No autorizado" });
    const body = request.body;
    if (
      !body ||
      !Number.isSafeInteger(body.manifestVersion) ||
      !Number.isFinite(body.diskUsedPercent) ||
      !storageTelemetryIsValid(body)
    ) {
      return reply.code(400).send({ error: "Telemetría inválida" });
    }
    await repository.recordTelemetry(frame.id, body);
    return reply.code(204).send();
  });

  return app;
}

function storageTelemetryIsValid(body: {
  diskTotalBytes?: number;
  diskUsedBytes?: number;
  diskAvailableBytes?: number;
  diskReservedBytes?: number;
  frameDataBytes?: number;
  mediaDataBytes?: number;
}): boolean {
  return [
    body.diskTotalBytes,
    body.diskUsedBytes,
    body.diskAvailableBytes,
    body.diskReservedBytes,
    body.frameDataBytes,
    body.mediaDataBytes,
  ].every(
    (value) =>
      value === undefined || (Number.isSafeInteger(value) && value >= 0),
  );
}

function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null {
  const match = header?.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;
  const suffixLength = !match[1] && match[2] ? Number(match[2]) : null;
  const start =
    suffixLength === null ? Number(match[1]) : Math.max(0, size - suffixLength);
  const end = suffixLength === null && match[2] ? Number(match[2]) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    end >= size
  ) {
    return null;
  }
  return { start, end };
}

async function authenticatedFrame(
  request: FastifyRequest,
  repository: Repository,
) {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice(7);
  if (token.length < 40 || token.length > 100) return null;
  return repository.authenticateFrame(token);
}

function bearerToken(request: FastifyRequest): string | null {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice(7);
  return token.length >= 40 && token.length <= 100 ? token : null;
}

function rawBearerToken(request: FastifyRequest): string | null {
  const authorization = request.headers.authorization;
  return authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
}

function decodeSha256(value: unknown): Buffer | null {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value)
    ? Buffer.from(value, "hex")
    : null;
}

function normalizeShortText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length >= 1 && normalized.length <= maximum
    ? normalized
    : null;
}

function validDimension(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 16_384;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}
