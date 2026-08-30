const token = process.env.TELEGRAM_BOT_TOKEN;
const apiBase = (process.env.TELEGRAM_API_BASE ?? "").replace(/\/$/, "");

if (!token || !apiBase) {
  throw new Error("Faltan TELEGRAM_BOT_TOKEN o TELEGRAM_API_BASE");
}

async function call(method, body = {}) {
  const response = await fetch(`${apiBase}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) {
    throw new Error(payload.description ?? `Telegram HTTP ${response.status}`);
  }
  return payload.result;
}

const commands = [
  { command: "start", description: "Iniciar o revisar la autorización" },
  { command: "vincular", description: "Vincularte a un marco mediante su código" },
  { command: "privacy", description: "Consultar la política de privacidad" },
];

await call("setMyCommands", { commands });
await call("setChatMenuButton", { menu_button: { type: "commands" } });
const configured = await call("getMyCommands");

console.log(JSON.stringify({ commands: configured, menuButton: "commands" }, null, 2));
