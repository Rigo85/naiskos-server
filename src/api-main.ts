import { buildApp, notifyTelemetryTransitions } from "./app.js";
import { loadConfig } from "./config.js";
import { createDatabase } from "./db.js";
import { Repository } from "./repository.js";
import { TelegramClient } from "./telegram.js";
import { ReleaseFeedback } from './release-feedback.js';

const config = loadConfig();
const database = createDatabase(config);
const app = await buildApp(config, database);

await app.listen({ host: config.host, port: config.port });

const fleetRepository = new Repository(database);
const telegram = new TelegramClient(config);
const releaseFeedback = new ReleaseFeedback(database,telegram,config.telegramAdminIds);
let monitorRunning = false;
async function monitorFleet(): Promise<void> {
  if (monitorRunning) return;
  monitorRunning = true;
  try {
    // Expiry notifications now use the same transactional delivery queue.
    await fleetRepository.expireReleaseCampaigns();
    const monthlyCampaign = await fleetRepository.ensureMonthlySystemUpdateCampaign();
    if (monthlyCampaign) {
      await Promise.allSettled([...config.telegramAdminIds].map((adminId) =>
        telegram.sendMessage(
          adminId,
          `🛠 Campaña mensual del SO creada automáticamente.\nID: ${monthlyCampaign}\nEtapa activa: piloto.`,
        ),
      ));
    }
    const systemCampaignChanges = await fleetRepository.advanceSystemUpdateCampaigns();
    if (systemCampaignChanges.length) {
      await Promise.allSettled([...config.telegramAdminIds].flatMap((adminId) =>
        systemCampaignChanges.map((change) =>
          telegram.sendMessage(adminId, `🛠 Campaña del SO: ${change}`),
        ),
      ));
    }
    const transitions = await fleetRepository.evaluateOfflineFrames(
      config.telemetryOfflineMinutes,
    );
    if (transitions.length) {
      await notifyTelemetryTransitions(
        telegram,
        config.telegramAdminIds,
        transitions,
        app.log,
      );
    }
  } catch (error) {
    app.log.error({ err: error }, "Falló la evaluación de salud de la flota");
  } finally {
    monitorRunning = false;
  }
}
const fleetMonitorTimer = setInterval(() => void monitorFleet(), 60_000);
fleetMonitorTimer.unref();
const telemetryPruneTimer = setInterval(() => {
  void fleetRepository.pruneTelemetrySamples(config.telemetryRetentionDays)
    .catch((error) => app.log.error({ err: error }, "Falló la retención de telemetría"));
}, 24 * 60 * 60_000);
telemetryPruneTimer.unref();
void monitorFleet();
let feedbackRunning=false;
async function refreshReleaseFeedback():Promise<void> {
  if(feedbackRunning) return;
  feedbackRunning=true;
  try { await releaseFeedback.runOnce(); }
  catch(error) { app.log.error({err:error},'Falló entrega de feedback de releases; se reintentará'); }
  finally { feedbackRunning=false; }
}
const feedbackTimer=setInterval(()=>void refreshReleaseFeedback(),30_000);
feedbackTimer.unref();
void refreshReleaseFeedback();

async function shutdown(signal: string): Promise<void> {
  clearInterval(fleetMonitorTimer);
  clearInterval(feedbackTimer);
  clearInterval(telemetryPruneTimer);
  app.log.info({ signal }, "Deteniendo Naiskos API");
  await app.close();
  await database.end();
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
