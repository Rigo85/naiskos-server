const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
const apiBase = (process.env.TELEGRAM_API_BASE ?? "").replace(/\/$/, "");
const webhookUrl =
  process.env.NAISKOS_TELEGRAM_WEBHOOK_URL ??
  "http://127.0.0.1:8090/webhooks/telegram";

if (!token || !secret || !apiBase) {
  throw new Error("Faltan TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET o TELEGRAM_API_BASE");
}
if (!/^[A-Za-z0-9_-]{1,256}$/.test(secret)) {
  throw new Error("TELEGRAM_WEBHOOK_SECRET tiene caracteres no admitidos");
}

async function call(method, body = {}) {
  const response = await fetch(`${apiBase}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(payload.description ?? `Telegram HTTP ${response.status}`);
  }
  return payload.result;
}

await call("setWebhook", {
  url: webhookUrl,
  secret_token: secret,
  allowed_updates: ["message", "callback_query"],
  drop_pending_updates: false,
});
const info = await call("getWebhookInfo");
console.log(
  JSON.stringify(
    {
      url: info.url,
      pendingUpdateCount: info.pending_update_count,
      lastErrorDate: info.last_error_date ?? null,
      lastErrorMessage: info.last_error_message ?? null,
    },
    null,
    2,
  ),
);
