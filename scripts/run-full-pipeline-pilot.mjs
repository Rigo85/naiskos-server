import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Pool } from "pg";

import {
  PostgresProvisioningStore,
  ProvisioningService,
} from "../dist/admin/provisioning.js";
import { buildApp } from "../dist/app.js";
import { Repository } from "../dist/repository.js";
import { MediaWorker } from "../dist/worker.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const photoPath = process.env.TEST_PHOTO_PATH;
const videoPath = process.env.TEST_VIDEO_PATH;
if (!databaseUrl || !photoPath || !videoPath) {
  throw new Error(
    "TEST_DATABASE_URL, TEST_PHOTO_PATH y TEST_VIDEO_PATH son obligatorios",
  );
}

const [{ SyncEngine }, { emptyManifest }, { buildApp: buildAgentApp }] = await Promise.all([
  import("../../naiskos-agent/dist/sync-engine.js"),
  import("../../naiskos-agent/dist/validation.js"),
  import("../../naiskos-agent/dist/app.js"),
]);

class LocalTelegram {
  messages = [];

  constructor(files) {
    this.files = files;
  }

  async fileSource(fileId) {
    const file = this.files.get(fileId);
    if (!file) throw new Error(`Archivo de prueba desconocido: ${fileId}`);
    return { kind: "local", path: file };
  }

  async sendMessage(chatId, text) {
    this.messages.push({ chatId, text });
  }
}

const database = new Pool({ connectionString: databaseUrl, max: 2 });
const storageRoot = await mkdtemp(
  path.join(os.tmpdir(), "naiskos-central-pilot-"),
);
const agentDataRoot = await mkdtemp(
  path.join(os.tmpdir(), "naiskos-agent-pilot-"),
);
const repository = new Repository(database);
const provisioning = new ProvisioningService(
  new PostgresProvisioningStore(database),
  "naiskosbot",
);
const frame = await provisioning.createFrame({ name: "Marco piloto completo" });
const invitation = await provisioning.createInvitation({ frameId: frame.frameId });
const telegramId = `pilot-${randomUUID()}`;
const user = await repository.upsertPendingTelegramUser(
  telegramId,
  "Remitente piloto",
);
const photoUniqueId = `photo-${randomUUID()}`;
const videoUniqueId = `video-${randomUUID()}`;
const jobIds = [];
let app = null;

try {
  await repository.claimInvitation(invitation.code, user.id);
  const approval = await repository.approveTelegramUser(telegramId, "99999");
  if (!approval.approved) throw new Error("No se aprobó el remitente piloto");

  jobIds.push(
    await repository.enqueueIngest({
      chatId: telegramId,
      telegramFileId: "photo-file",
      telegramFileUniqueId: photoUniqueId,
      kind: "photo",
      mimeType: "image/jpeg",
      originalName: path.basename(photoPath),
      sizeBytes: (await stat(photoPath)).size,
      durationSeconds: null,
      caption: "Foto piloto",
      senderName: "Remitente piloto",
      telegramUserId: user.id,
      frameIds: [frame.frameId],
    }),
  );
  jobIds.push(
    await repository.enqueueIngest({
      chatId: telegramId,
      telegramFileId: "video-file",
      telegramFileUniqueId: videoUniqueId,
      kind: "video",
      mimeType: "video/mp4",
      originalName: path.basename(videoPath),
      sizeBytes: (await stat(videoPath)).size,
      durationSeconds: null,
      caption: "Video piloto",
      senderName: "Remitente piloto",
      telegramUserId: user.id,
      frameIds: [frame.frameId],
    }),
  );

  const telegram = new LocalTelegram(
    new Map([
      ["photo-file", photoPath],
      ["video-file", videoPath],
    ]),
  );
  const serverConfig = {
    host: "127.0.0.1",
    port: 0,
    publicUrl: "http://127.0.0.1",
    databaseUrl,
    dbPoolMax: 2,
    storageRoot,
    telegramToken: "pilot-token",
    telegramWebhookSecret: "pilot-webhook-secret",
    telegramApiBase: "http://127.0.0.1:8092",
    telegramAdminIds: new Set(["99999"]),
    workerIntervalMs: 1_000,
    originalRetentionDays: 7,
    trashRetentionDays: 30,
    trustedProxies: ["127.0.0.1"],
  };
  const worker = new MediaWorker(serverConfig, database, telegram);
  if (!(await worker.runOnce()) || !(await worker.runOnce())) {
    throw new Error("El worker no reclamó los dos trabajos");
  }
  const jobs = await database.query(
    "SELECT status FROM naiskos.jobs WHERE id=ANY($1::uuid[]) ORDER BY created_at",
    [jobIds],
  );
  if (jobs.rows.some((job) => job.status !== "succeeded")) {
    throw new Error(`Trabajos incompletos: ${JSON.stringify(jobs.rows)}`);
  }

  app = await buildApp(serverConfig, database);
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  serverConfig.publicUrl = address;

  const agentConfig = {
    host: "127.0.0.1",
    port: 0,
    dataRoot: agentDataRoot,
    webRoot: agentDataRoot,
    centralUrl: address,
    frameId: frame.frameId,
    token: frame.agentToken,
    telegramBotUsername: "naiskosbot",
    deviceName: "Agente piloto",
    frameWidth: 1280,
    frameHeight: 800,
    syncIntervalMs: 5_000,
    diskBlockPercent: 99,
  };
  const engine = new SyncEngine(agentConfig, emptyManifest(frame.frameId));
  if ((await engine.sync()) !== "updated") {
    throw new Error("El agente no activó el manifiesto nuevo");
  }
  const manifest = engine.currentManifest();
  if (manifest.version !== 2 || manifest.media.length !== 2) {
    throw new Error(
      `Manifiesto inesperado: versión ${manifest.version}, ${manifest.media.length} medios`,
    );
  }
  for (const media of manifest.media) {
    const file = path.join(agentDataRoot, media.url.replace(/^\//, ""));
    const contents = await readFile(file);
    const sha256 = createHash("sha256").update(contents).digest("hex");
    if (sha256 !== media.sha256) {
      throw new Error(`Hash local inválido para ${media.id}`);
    }
  }
  const agentApp = await buildAgentApp(agentConfig, engine);
  const preference = await agentApp.inject({
    method: "PATCH",
    url: "/api/v1/settings",
    payload: { volume: 0.25 },
  });
  await agentApp.close();
  if (preference.statusCode !== 200 || preference.json().volume !== 0.25) {
    throw new Error("El agente no guardó la preferencia local");
  }
  if ((await engine.sync()) !== "unchanged") {
    throw new Error("La sincronización que vacía el outbox debía iniciar sin cambios");
  }
  if ((await engine.sync()) !== "updated") {
    throw new Error("El agente no recibió la versión central de su preferencia");
  }
  if (
    engine.currentManifest().version !== 3 ||
    engine.currentManifest().settings.volume !== 0.25
  ) {
    throw new Error("La preferencia no se reconcilió como manifiesto versión 3");
  }
  if ((await engine.sync()) !== "unchanged") {
    throw new Error("La sincronización final debía responder sin cambios");
  }
  const runtime = await database.query(
    `SELECT installed_version::text AS "installedVersion", agent_state AS "agentState"
       FROM naiskos.frame_runtime WHERE frame_id=$1`,
    [frame.frameId],
  );
  if (
    runtime.rows[0]?.installedVersion !== "3" ||
    runtime.rows[0]?.agentState !== "ready"
  ) {
    throw new Error(`Telemetría inesperada: ${JSON.stringify(runtime.rows[0])}`);
  }

  console.log(
    JSON.stringify(
      {
        result: "ok",
        jobs: 2,
        ingestedManifestVersion: manifest.version,
        finalManifestVersion: engine.currentManifest().version,
        media: manifest.media.map((item) => item.kind).sort(),
        notifications: telegram.messages.length,
        preferenceReplicated: true,
        finalSync: "unchanged",
        telemetry: runtime.rows[0],
      },
      null,
      2,
    ),
  );
} finally {
  await app?.close();
  await database.query(
    "DELETE FROM naiskos.audit_log WHERE frame_id=$1 OR actor_telegram_user_id=$2",
    [frame.frameId, user.id],
  );
  await database.query("DELETE FROM naiskos.frames WHERE id=$1", [frame.frameId]);
  await database.query(
    "DELETE FROM naiskos.media WHERE source_unique_id=ANY($1::text[])",
    [[photoUniqueId, videoUniqueId]],
  );
  if (jobIds.length) {
    await database.query("DELETE FROM naiskos.jobs WHERE id=ANY($1::uuid[])", [
      jobIds,
    ]);
  }
  await database.query("DELETE FROM naiskos.telegram_users WHERE id=$1", [
    user.id,
  ]);
  await database.end();
  await rm(storageRoot, { recursive: true, force: true });
  await rm(agentDataRoot, { recursive: true, force: true });
}
