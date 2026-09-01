import { buildApp, notifyTelemetryTransitions } from "./app.js";
import { loadConfig } from "./config.js";
import { createDatabase } from "./db.js";
import { Repository } from "./repository.js";
import { TelegramClient } from "./telegram.js";

const config = loadConfig();
const database = createDatabase(config);
const app = await buildApp(config, database);

await app.listen({ host: config.host, port: config.port });

const fleetRepository = new Repository(database);
const telegram = new TelegramClient(config);
let monitorRunning = false;
async function monitorFleet(): Promise<void> {
  if (monitorRunning) return;
  monitorRunning = true;
  try {
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

async function shutdown(signal: string): Promise<void> {
  clearInterval(fleetMonitorTimer);
  clearInterval(telemetryPruneTimer);
  app.log.info({ signal }, "Deteniendo Naiskos API");
  await app.close();
  await database.end();
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
