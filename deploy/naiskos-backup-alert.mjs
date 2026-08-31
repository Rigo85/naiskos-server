#!/usr/bin/env node

const apiBase = (process.env.TELEGRAM_API_BASE ?? "").replace(/\/$/, "");
const token = process.env.TELEGRAM_BOT_TOKEN;
const administrators = (process.env.TELEGRAM_ADMIN_IDS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const unit = process.argv[2] ?? "naiskos-backup.service";
const isTest = process.env.NAISKOS_BACKUP_ALERT_TEST === "1";

if (!apiBase || !token || administrators.length === 0) {
  throw new Error("No hay configuración Telegram completa para alertar el fallo del backup");
}

const pause = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function send(chatId) {
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(`${apiBase}/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: isTest
            ? "Naiskos: prueba controlada de la alerta de backup completada. No ocurrió ningún fallo."
            : `Naiskos: falló ${unit} en el servidor central. ` +
              "Las copias anteriores permanecen intactas. Revisa systemctl y journalctl.",
        }),
        signal: AbortSignal.timeout(20_000),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) {
        throw new Error(payload.description ?? `Telegram HTTP ${response.status}`);
      }
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 4) await pause(1_000 * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}

await Promise.all(administrators.map(send));
