import { afterEach, describe, expect, it, vi } from "vitest";

import { ServerConfig } from "../src/config.js";
import {
  DeviceEnrollmentMutationResult,
  DeviceEnrollmentSummary,
  IngestJobPayload,
  InvitationResult,
  TelegramApprovalResult,
  TelegramUser,
  FleetAlert,
  FleetFrameStatus,
  ReleaseCampaignSummary,
  SystemUpdateCampaignSummary,
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
  campaigns: ReleaseCampaignSummary[] = [];
  systemCampaigns: SystemUpdateCampaignSummary[] = [];
  frames: Array<{ id: string; name: string }> = [];
  enqueued: IngestJobPayload[] = [];

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
    return this.frames;
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

  async enqueueIngest(payload: IngestJobPayload): Promise<string> {
    this.enqueued.push(payload);
    return "job";
  }

  async listFleetStatus(): Promise<FleetFrameStatus[]> {
    return [{
      id: "11111111-1111-4111-8111-111111111111",
      name: "Sala",
      frameStatus: "active",
      agentState: "ready",
      lastSeenAt: new Date(),
      lastFullTelemetryAt: new Date(),
      temperatureC: 48.2,
      diskUsedPercent: 32.5,
      memoryUsedPercent: 41.7,
      releaseId: "20260831-test",
      manifestVersion: 12,
      activeAlerts: 0,
    }];
  }

  async findFleetFrame(): Promise<FleetFrameStatus | null> {
    return (await this.listFleetStatus())[0] ?? null;
  }

  async listFleetAlerts(): Promise<FleetAlert[]> {
    return [];
  }

  async listReleaseCampaigns(): Promise<ReleaseCampaignSummary[]> {
    return this.campaigns;
  }

  async transitionReleaseCampaign(
    campaignId: string,
    action: "approve" | "pause" | "cancel",
  ): Promise<boolean> {
    const campaign = this.campaigns.find((candidate) => candidate.id === campaignId);
    if (!campaign) return false;
    campaign.status = action === "approve" ? "approved" : action === "pause" ? "paused" : "cancelled";
    return true;
  }

  async listSystemUpdateCampaigns(): Promise<SystemUpdateCampaignSummary[]> {
    return this.systemCampaigns;
  }

  async transitionSystemUpdateCampaign(
    campaignId: string,
    action: "resume" | "pause" | "cancel",
  ): Promise<boolean> {
    const campaign = this.systemCampaigns.find((candidate) => candidate.id === campaignId);
    if (!campaign) return false;
    campaign.status = action === "resume" ? "approved" : action === "pause" ? "paused" : "cancelled";
    return true;
  }
}

class StubTelegram implements TelegramTransport {
  messages: Array<{ chatId: number | string; text: string; markup?: object }> = [];
  answers: Array<{ id: string; text: string }> = [];
  edits: Array<{ chatId: number | string; messageId: number; text: string; markup?: object }> = [];

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

  async editMessageText(
    chatId: number | string,
    messageId: number,
    text: string,
    replyMarkup?: object,
  ): Promise<void> {
    this.edits.push({
      chatId,
      messageId,
      text,
      ...(replyMarkup ? { markup: replyMarkup } : {}),
    });
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
  it("encola un medio sin depender de un mensaje inmediato de confirmación", async () => {
    const repository = new StubRepository();
    repository.user = {
      id: "user-1",
      telegramId: "10",
      status: "approved",
    };
    repository.frames = [{ id: "frame-1", name: "Sala" }];
    const telegram = new StubTelegram();
    const handler = new TelegramHandler(telegramConfig, repository, telegram);

    await handler.handle({
      update_id: 88,
      message: {
        message_id: 88,
        chat: { id: 10 },
        from: { id: 10, first_name: "Rigo" },
        photo: [{
          file_id: "photo-file",
          file_unique_id: "photo-unique",
          file_size: 123,
        }],
      },
    });

    expect(repository.enqueued).toHaveLength(1);
    expect(telegram.messages).toHaveLength(0);
  });

  it("edita sólo la campaña afectada después de una acción", async () => {
    const repository = new StubRepository();
    repository.campaigns = [
      {
        id: "11111111-1111-4111-8111-111111111111",
        releaseId: "20260901-test-001",
        status: "draft",
        frames: 1,
        installed: 0,
        failed: 0,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 72 * 60 * 60_000),
      },
      {
        id: "22222222-2222-4222-8222-222222222222",
        releaseId: "20260901-old-001",
        status: "completed",
        frames: 1,
        installed: 1,
        failed: 0,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 72 * 60 * 60_000),
      },
    ];
    const telegram = new StubTelegram();
    const handler = new TelegramHandler(telegramConfig, repository, telegram);

    await handler.handle({
      update_id: 89,
      callback_query: {
        id: "callback-89",
        from: { id: 99, first_name: "Admin" },
        data: "release-approve:11111111-1111-4111-8111-111111111111",
        message: { message_id: 700, chat: { id: 99 } },
      },
    });

    expect(telegram.messages).toHaveLength(0);
    expect(telegram.edits).toHaveLength(1);
    expect(telegram.edits[0]).toMatchObject({
      chatId: 99,
      messageId: 700,
    });
    expect(telegram.edits[0]?.text).toContain("Estado: approved");
    expect(JSON.stringify(telegram.edits[0]?.markup)).toContain("release-pause");
  });

  it("consulta y pausa la campaña mensual del SO sin reenviar el listado", async () => {
    const repository = new StubRepository();
    repository.systemCampaigns = [{
      id: "33333333-3333-4333-8333-333333333333",
      period: "2026-09",
      status: "approved",
      activeStage: "pilot",
      frames: 1,
      installed: 0,
      failed: 0,
      scheduledAt: new Date("2026-09-06T05:30:00.000Z"),
    }];
    const telegram = new StubTelegram();
    const handler = new TelegramHandler(telegramConfig, repository, telegram);

    await handler.handle({
      update_id: 90,
      message: {
        message_id: 90,
        chat: { id: 99 },
        from: { id: 99, first_name: "Admin" },
        text: "/sistema",
      },
    });
    expect(telegram.messages).toHaveLength(1);
    expect(telegram.messages[0]?.text).toContain("SO 2026-09");
    expect(JSON.stringify(telegram.messages[0]?.markup)).toContain("system-pause");

    telegram.messages.length = 0;
    await handler.handle({
      update_id: 91,
      callback_query: {
        id: "callback-91",
        from: { id: 99, first_name: "Admin" },
        data: "system-pause:33333333-3333-4333-8333-333333333333",
        message: { message_id: 701, chat: { id: 99 } },
      },
    });
    expect(telegram.messages).toHaveLength(0);
    expect(telegram.edits).toHaveLength(1);
    expect(telegram.edits[0]?.text).toContain("Estado: paused");
    expect(JSON.stringify(telegram.edits[0]?.markup)).toContain("system-resume");
  });

  it("permite consultar flota y alertas sólo al administrador", async () => {
    const repository = new StubRepository();
    const telegram = new StubTelegram();
    const handler = new TelegramHandler(telegramConfig, repository, telegram);

    await handler.handle({
      update_id: 90,
      message: {
        message_id: 90,
        chat: { id: 99 },
        from: { id: 99, first_name: "Admin" },
        text: "/marcos",
      },
    });
    expect(telegram.messages[0]?.text).toContain("Marcos: 1");
    expect(telegram.messages[0]?.text).toContain("Sala");

    await handler.handle({
      update_id: 91,
      message: {
        message_id: 91,
        chat: { id: 99 },
        from: { id: 99, first_name: "Admin" },
        text: "/marco Sala",
      },
    });
    expect(telegram.messages.at(-1)?.text).toContain("Temperatura: 48.2 °C");

    const denied = new StubTelegram();
    await new TelegramHandler(telegramConfig, repository, denied).handle({
      update_id: 92,
      message: {
        message_id: 92,
        chat: { id: 10 },
        from: { id: 10, first_name: "Persona" },
        text: "/alertas",
      },
    });
    expect(denied.messages[0]?.text).toContain("reservada");
  });

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

  it("rechaza GIF y documentos ajenos al MVP antes de encolarlos", () => {
    const base = {
      message_id: 1,
      chat: { id: 10 },
    };
    expect(
      extractMedia(
        {
          ...base,
          document: {
            file_id: "gif",
            file_unique_id: "gif-unique",
            mime_type: "image/gif",
            file_name: "animacion.gif",
          },
        },
        "user-1",
        "Rigo",
        ["frame-1"],
      ),
    ).toBeNull();
    expect(
      extractMedia(
        {
          ...base,
          document: {
            file_id: "pdf",
            file_unique_id: "pdf-unique",
            mime_type: "application/pdf",
            file_name: "archivo.pdf",
          },
        },
        "user-1",
        "Rigo",
        ["frame-1"],
      ),
    ).toBeNull();
  });
});
