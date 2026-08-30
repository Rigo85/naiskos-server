const token = process.env.TELEGRAM_BOT_TOKEN;
const localBase = (process.env.TELEGRAM_API_BASE ?? "http://127.0.0.1:8092").replace(
  /\/$/,
  "",
);

if (!token) {
  throw new Error("Falta TELEGRAM_BOT_TOKEN");
}
if (!localBase.startsWith("http://127.0.0.1:")) {
  throw new Error("TELEGRAM_API_BASE debe apuntar al Bot API local");
}

async function call(base, method, body = {}, timeout = 20_000) {
  const response = await fetch(`${base}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) {
    throw new Error(payload.description ?? `Telegram HTTP ${response.status}`);
  }
  return payload.result;
}

const publicBase = "https://api.telegram.org";
const publicWebhook = await call(publicBase, "getWebhookInfo");
console.log(
  JSON.stringify({
    phase: "public-before-logout",
    webhookConfigured: Boolean(publicWebhook.url),
    pendingUpdateCount: publicWebhook.pending_update_count,
  }),
);

const loggedOut = await call(publicBase, "logOut");
if (loggedOut !== true) {
  throw new Error("Telegram no confirmó logOut de la API pública");
}
console.log(JSON.stringify({ phase: "public-logout", ok: true }));

let bot = null;
let lastError = null;
for (let attempt = 1; attempt <= 30; attempt += 1) {
  try {
    bot = await call(localBase, "getMe", {}, 10_000);
    break;
  } catch (error) {
    lastError = error;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}
if (!bot) {
  throw new Error(`El Bot API local no inició sesión: ${lastError?.message ?? "sin detalle"}`);
}

console.log(
  JSON.stringify({
    phase: "local-ready",
    id: bot.id,
    username: bot.username,
    name: bot.first_name,
  }),
);
