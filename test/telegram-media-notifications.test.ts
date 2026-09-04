import { describe, expect, it, vi } from "vitest";

import { ServerConfig } from "../src/config.js";
import { formatTelegramMediaNotice } from "../src/telegram-media-notifications.js";
import { TelegramApiError, TelegramClient } from "../src/telegram.js";

describe("avisos agrupados de medios", () => {
  it("resume los resultados sin emitir un mensaje por archivo", () => {
    expect(formatTelegramMediaNotice("media.received", 37)).toContain(
      "37 contenidos recibidos",
    );
    expect(formatTelegramMediaNotice("media.ready", 37)).toContain(
      "37 contenidos ya están listos",
    );
    expect(formatTelegramMediaNotice("media.duplicate", 4)).toContain(
      "4 contenidos ya estaban disponibles",
    );
  });

  it("conserva retry_after cuando Telegram limita la entrega", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: false,
            error_code: 429,
            description: "Too Many Requests: retry after 1746",
            parameters: { retry_after: 1746 },
          }),
          {
            status: 429,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    );
    const client = new TelegramClient({
      telegramToken: "token",
      telegramApiBase: "https://api.telegram.test",
    } as ServerConfig);

    const error = await client.sendMessage("123", "hola").catch((reason) => reason);
    expect(error).toBeInstanceOf(TelegramApiError);
    expect((error as TelegramApiError).retryAfterSeconds).toBe(1746);
    vi.unstubAllGlobals();
  });
});
