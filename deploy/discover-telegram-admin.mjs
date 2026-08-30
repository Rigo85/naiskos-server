const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("TELEGRAM_BOT_TOKEN es obligatorio");

const response = await fetch(
  `https://api.telegram.org/bot${token}/getUpdates?timeout=0&allowed_updates=%5B%22message%22%5D`,
  { signal: AbortSignal.timeout(20_000) },
);
const payload = await response.json();
if (!response.ok || !payload.ok) {
  throw new Error(payload.description ?? `Telegram HTTP ${response.status}`);
}

const senders = new Map();
for (const update of payload.result) {
  const message = update.message;
  const from = message?.from;
  if (!from || message.chat?.type !== "private") continue;
  senders.set(String(from.id), {
    telegramUserId: String(from.id),
    name: [from.first_name, from.last_name].filter(Boolean).join(" "),
    username: from.username ? `@${from.username}` : null,
    lastText: message.text ?? null,
  });
}

if (senders.size === 0) {
  console.log(
    "No hay mensajes privados pendientes. Abre @naiskosbot, pulsa Iniciar o envía /start y vuelve a ejecutar este comando.",
  );
} else {
  console.log(JSON.stringify([...senders.values()], null, 2));
}
