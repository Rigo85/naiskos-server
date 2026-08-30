import { afterEach, describe, expect, it, vi } from "vitest";

import { ServerConfig } from "../src/config.js";
import {
  DeviceEnrollmentMutationResult,
  DeviceEnrollmentSummary,
  IngestJobPayload,
  InvitationResult,
  TelegramApprovalResult,
  TelegramUser,
} from "../src/repository.js";
import {
  extractMedia,
  TelegramClient,
  TelegramHandler,
  TelegramRepository,
  TelegramTransport,
} from "../src/telegram.js";

class StubRepository implements TelegramRepository {
  user: TelegramUser | null = null;
  claimed: Array<{ code: string; userId: string }> = [];
  pairingClaims: Array<{ code: string; userId: string }> = [];
  pairingLinks: Array<{ code: string; userId: string }> = [];
  claimResult: InvitationResult | null = {
    frameId: "frame-1",
    frameName: "Sala",
  };
  approvalResult: TelegramApprovalResult = {
    approved: true,
    grantedFrames: [{ frameId: "frame-1", frameName: "Sala" }],
  };
  deviceEnrollment: DeviceEnrollmentSummary | null = null;
  deviceMutation: DeviceEnrollmentMutationResult = {
    changed: false,
    status: "missing",
  };

  async findDeviceEnrollmentByClaimCode(): Promise<DeviceEnrollmentSummary | null> {
    return this.deviceEnrollment;
  }

  async approveDeviceEnrollment(): Promise<DeviceEnrollmentMutationResult> {
    return this.deviceMutation;
  }

  async rejectDeviceEnrollment(): Promise<DeviceEnrollmentMutationResult> {
    return { changed: false, status: "missing" };
  }

  async findTelegramUser(): Promise<TelegramUser | null> {
    return this.user;
  }

  async upsertPendingTelegramUser(
    telegramId: string,
  ): Promise<TelegramUser> {
    return { id: "user-1", telegramId, status: "pending" };
  }

  async claimInvitation(
    code: string,
    telegramUserId: string,
  ): Promise<InvitationResult | null> {
    this.claimed.push({ code, userId: telegramUserId });
    return this.claimResult;
  }

  async consumeInvitation(): Promise<InvitationResult | null> {
    return null;
  }

  async claimFrameByPairingCode(
    code: string,
    telegramUserId: string,
  ): Promise<InvitationResult | null> {
    this.pairingClaims.push({ code, userId: telegramUserId });
    return this.claimResult;
  }

  async linkFrameByPairingCode(
    code: string,
    telegramUserId: string,
  ): Promise<InvitationResult | null> {
    this.pairingLinks.push({ code, userId: telegramUserId });
    return this.claimResult;
  }

  async approveTelegramUser(): Promise<TelegramApprovalResult> {
    return this.approvalResult;
  }

  async rejectTelegramUser(): Promise<boolean> {
    return false;
  }

  async blockTelegramUser(): Promise<boolean> {
    return false;
  }

  async unblockTelegramUser(): Promise<boolean> {
    return false;
  }

  async revokeTelegramUser(): Promise<boolean> {
    return false;
  }

  async reactivateTelegramUser(): Promise<boolean> {
    return false;
  }

  async accessibleFrames(): Promise<Array<{ id: string; name: string }>> {
    return [];
  }

  async createPendingSelection(): Promise<string> {
    return "selection";
  }

  async updatePendingSelection(): Promise<{
    state: "updated" | "completed" | "missing" | "empty";
    payload?: IngestJobPayload;
    count?: number;
  }> {
    return { state: "missing" };
  }

  async enqueueIngest(): Promise<string> {
    return "job";
  }
}

class StubTelegram implements TelegramTransport {
  messages: Array<{ chatId: number | string; text: string; markup?: object }> = [];
  answers: Array<{ id: string; text: string }> = [];

  async sendMessage(
    chatId: number | string,
    text: string,
    replyMarkup?: object,
  ): Promise<void> {
    this.messages.push({
      chatId,
      text,
      ...(replyMarkup ? { markup: replyMarkup } : {}),
    });
  }

  async answerCallbackQuery(id: string, text: string): Promise<void> {
    this.answers.push({ id, text });
  }
}

const telegramConfig = {
  telegramAdminIds: new Set(["99"]),
} as ServerConfig;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("archivos de Telegram", () => {
  it("usa directamente la ruta absoluta entregada por el Bot API local", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          result: { file_path: "/srv/telegram/123/video.mp4" },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new TelegramClient({
      telegramToken: "token",
      telegramApiBase: "http://127.0.0.1:8092",
    } as ServerConfig);

    await expect(client.fileSource("file-id")).resolves.toEqual({
      kind: "local",
      path: "/srv/telegram/123/video.mp4",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("descarga por HTTP cuando el Bot API entrega una ruta relativa", async () => {
    const fileResponse = new Response("contenido");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: true,
            result: { file_path: "videos/video.mp4" },
          }),
          { headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(fileResponse);
    vi.stubGlobal("fetch", fetchMock);
    const client = new TelegramClient({
      telegramToken: "token",
      telegramApiBase: "https://api.telegram.test",
    } as ServerConfig);

    const source = await client.fileSource("file-id");
    expect(source.kind).toBe("remote");
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.telegram.test/file/bottoken/videos/video.mp4",
      expect.any(Object),
    );
  });
});

describe("entrada de Telegram", () => {
  it("publica la política de privacidad incluso antes de autorizar al usuario", async () => {
    const repository = new StubRepository();
    const telegram = new StubTelegram();
    const handler = new TelegramHandler(
      {
        ...telegramConfig,
        publicUrl: "https://naiskos.example.com",
      },
      repository,
      telegram,
    );

    await handler.handle({
      update_id: 1,
      message: {
        message_id: 1,
        chat: { id: 10 },
        from: { id: 10, first_name: "Persona" },
        text: "/privacy",
      },
    });

    expect(telegram.messages[0]?.text).toContain(
      "https://naiskos.example.com/privacidad",
    );
  });

  it("permite que sólo el administrador apruebe el alta de un dispositivo", async () => {
    const repository = new StubRepository();
    repository.deviceEnrollment = {
      requestId: "e410e4df-7e9a-4e18-a088-56a775c1b74e",
      status: "pending",
      deviceModel: "Raspberry Pi 4 Model B Rev 1.5",
      suggestedName: "Naiskos 5D5CF4",
      width: 1280,
      height: 800,
      expiresAt: "2026-08-29T20:00:00.000Z",
      frameId: null,
      frameName: null,
    };
    const telegram = new StubTelegram();
    const handler = new TelegramHandler(telegramConfig, repository, telegram);

    await handler.handle({
      update_id: 1,
      message: {
        message_id: 1,
        chat: { id: 99 },
        from: { id: 99, first_name: "Admin" },
        text: "/start enroll_codigo",
      },
    });
    expect(telegram.messages[0]?.text).toContain("Raspberry Pi 4");
    expect(telegram.messages[0]?.markup).toBeDefined();

    const deniedTelegram = new StubTelegram();
    const deniedHandler = new TelegramHandler(
      telegramConfig,
      repository,
      deniedTelegram,
    );
    await deniedHandler.handle({
      update_id: 2,
      message: {
        message_id: 2,
        chat: { id: 10 },
        from: { id: 10, first_name: "No admin" },
        text: "/start enroll_codigo",
      },
    });
    expect(deniedTelegram.messages[0]?.text).toContain("Sólo un administrador");
  });

  it("reserva la invitación mientras solicita la aprobación global", async () => {
    const repository = new StubRepository();
    const telegram = new StubTelegram();
    const handler = new TelegramHandler(telegramConfig, repository, telegram);

    await handler.handle({
      update_id: 1,
      message: {
        message_id: 1,
        chat: { id: 10 },
        from: { id: 10, first_name: "Rigo" },
        text: "/start invitacion123",
      },
    });

    expect(repository.claimed).toEqual([
      { code: "invitacion123", userId: "user-1" },
    ]);
    expect(telegram.messages.some((message) => message.text.includes("«Sala»"))).toBe(
      true,
    );
    expect(
      telegram.messages.some(
        (message) => message.chatId === "99" && message.text.includes("Sala"),
      ),
    ).toBe(true);
  });

  it("vincula a un usuario aprobado mediante el QR estable del marco", async () => {
    const repository = new StubRepository();
    repository.user = { id: "user-1", telegramId: "10", status: "approved" };
    const telegram = new StubTelegram();
    const handler = new TelegramHandler(telegramConfig, repository, telegram);

    await handler.handle({
      update_id: 3,
      message: {
        message_id: 3,
        chat: { id: 10 },
        from: { id: 10, first_name: "Rigo" },
        text: "/start frame_ABCD2345EFGH",
      },
    });

    expect(repository.pairingLinks).toEqual([
      { code: "ABCD2345EFGH", userId: "user-1" },
    ]);
    expect(telegram.messages[0]?.text).toContain("Quedaste vinculado");
  });

  it("reserva el marco si el QR se escanea antes de la aprobación global", async () => {
    const repository = new StubRepository();
    const telegram = new StubTelegram();
    const handler = new TelegramHandler(telegramConfig, repository, telegram);

    await handler.handle({
      update_id: 4,
      message: {
        message_id: 4,
        chat: { id: 10 },
        from: { id: 10, first_name: "Rigo" },
        text: "/vincular ABCD-2345-EFGH",
      },
    });

    expect(repository.pairingClaims).toEqual([
      { code: "ABCD2345EFGH", userId: "user-1" },
    ]);
    expect(telegram.messages.some((message) => message.text.includes("«Sala»"))).toBe(true);
  });

  it("notifica que la aprobación también vinculó el marco reservado", async () => {
    const repository = new StubRepository();
    const telegram = new StubTelegram();
    const handler = new TelegramHandler(telegramConfig, repository, telegram);

    await handler.handle({
      update_id: 2,
      callback_query: {
        id: "callback-1",
        from: { id: 99, first_name: "Admin" },
        data: "approve:10",
      },
    });

    expect(telegram.answers[0]?.text).toContain("vinculado");
    expect(
      telegram.messages.some(
        (message) => message.chatId === "10" && message.text.includes("«Sala»"),
      ),
    ).toBe(true);
  });

  it("elige la variante fotográfica de mayor tamaño", () => {
    const payload = extractMedia(
      {
        message_id: 1,
        chat: { id: 10 },
        photo: [
          { file_id: "small", file_unique_id: "same", file_size: 10 },
          { file_id: "large", file_unique_id: "same", file_size: 100 },
        ],
      },
      "user-1",
      "Rigo",
      ["frame-1"],
    );
    expect(payload?.telegramFileId).toBe("large");
    expect(payload?.frameIds).toEqual(["frame-1"]);
  });

  it("acepta una imagen enviada como documento", () => {
    const payload = extractMedia(
      {
        message_id: 1,
        chat: { id: 10 },
        document: {
          file_id: "document",
          file_unique_id: "unique",
          mime_type: "image/heic",
          file_name: "foto.heic",
        },
      },
      "user-1",
      "Rigo",
      ["frame-1"],
    );
    expect(payload?.kind).toBe("photo");
    expect(payload?.originalName).toBe("foto.heic");
  });
});
