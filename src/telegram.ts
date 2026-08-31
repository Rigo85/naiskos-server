import path from "node:path";

import { ServerConfig } from "./config.js";
import {
  DeviceEnrollmentMutationResult,
  DeviceEnrollmentSummary,
  IngestJobPayload,
  InvitationResult,
  TelegramApprovalResult,
  TelegramUser,
} from "./repository.js";

interface TelegramFrom {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
}

interface TelegramMessage {
  message_id: number;
  chat: { id: number };
  from?: TelegramFrom;
  text?: string;
  caption?: string;
  photo?: Array<{
    file_id: string;
    file_unique_id: string;
    file_size?: number;
  }>;
  video?: {
    file_id: string;
    file_unique_id: string;
    file_size?: number;
    duration: number;
    mime_type?: string;
    file_name?: string;
  };
  document?: {
    file_id: string;
    file_unique_id: string;
    file_size?: number;
    mime_type?: string;
    file_name?: string;
  };
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: {
    id: string;
    from: TelegramFrom;
    data?: string;
    message?: TelegramMessage;
  };
}

export interface TelegramRepository {
  findDeviceEnrollmentByClaimCode(
    code: string,
  ): Promise<DeviceEnrollmentSummary | null>;
  approveDeviceEnrollment(
    requestId: string,
    actorTelegramId: string,
  ): Promise<DeviceEnrollmentMutationResult>;
  rejectDeviceEnrollment(
    requestId: string,
    actorTelegramId: string,
  ): Promise<DeviceEnrollmentMutationResult>;
  findTelegramUser(telegramId: string): Promise<TelegramUser | null>;
  upsertPendingTelegramUser(
    telegramId: string,
    displayName: string,
  ): Promise<TelegramUser>;
  claimInvitation(
    code: string,
    telegramUserId: string,
  ): Promise<InvitationResult | null>;
  consumeInvitation(
    code: string,
    telegramUserId: string,
  ): Promise<InvitationResult | null>;
  claimFrameByPairingCode(
    code: string,
    telegramUserId: string,
  ): Promise<InvitationResult | null>;
  linkFrameByPairingCode(
    code: string,
    telegramUserId: string,
  ): Promise<InvitationResult | null>;
  approveTelegramUser(
    telegramId: string,
    actorTelegramId: string,
  ): Promise<TelegramApprovalResult>;
  rejectTelegramUser(telegramId: string, actorTelegramId: string): Promise<boolean>;
  blockTelegramUser(telegramId: string, actorTelegramId: string): Promise<boolean>;
  unblockTelegramUser(telegramId: string, actorTelegramId: string): Promise<boolean>;
  revokeTelegramUser(telegramId: string, actorTelegramId: string): Promise<boolean>;
  reactivateTelegramUser(
    telegramId: string,
    actorTelegramId: string,
  ): Promise<boolean>;
  accessibleFrames(
    telegramUserId: string,
  ): Promise<Array<{ id: string; name: string }>>;
  createPendingSelection(
    telegramUserId: string,
    payload: IngestJobPayload,
    frameIds: string[],
  ): Promise<string>;
  updatePendingSelection(
    code: string,
    telegramUserId: string,
    operation: "all" | "toggle" | "done",
    index?: number,
  ): Promise<{
    state: "updated" | "completed" | "missing" | "empty";
    payload?: IngestJobPayload;
    count?: number;
  }>;
  enqueueIngest(payload: IngestJobPayload): Promise<string>;
}

export interface TelegramTransport {
  sendMessage(
    chatId: number | string,
    text: string,
    replyMarkup?: object,
  ): Promise<unknown>;
  answerCallbackQuery(callbackQueryId: string, text: string): Promise<unknown>;
}

export type TelegramFileSource =
  | { kind: "local"; path: string }
  | { kind: "remote"; response: Response };

export class TelegramClient {
  constructor(private readonly config: ServerConfig) {}

  async call<T>(method: string, body: object): Promise<T> {
    if (!this.config.telegramToken)
      throw new Error("TELEGRAM_BOT_TOKEN no configurado");
    const response = await fetch(
      `${this.config.telegramApiBase}/bot${this.config.telegramToken}/${method}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      },
    );
    const result = (await response.json()) as {
      ok: boolean;
      result: T;
      description?: string;
    };
    if (!response.ok || !result.ok)
      throw new Error(result.description ?? `Telegram HTTP ${response.status}`);
    return result.result;
  }

  sendMessage(
    chatId: number | string,
    text: string,
    replyMarkup?: object,
  ): Promise<unknown> {
    return this.call("sendMessage", {
      chat_id: chatId,
      text,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  }

  answerCallbackQuery(callbackQueryId: string, text: string): Promise<unknown> {
    return this.call("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      text,
    });
  }

  async fileSource(fileId: string): Promise<TelegramFileSource> {
    const file = await this.call<{ file_path: string }>("getFile", {
      file_id: fileId,
    });
    if (path.isAbsolute(file.file_path)) {
      return { kind: "local", path: file.file_path };
    }
    if (!this.config.telegramToken)
      throw new Error("TELEGRAM_BOT_TOKEN no configurado");
    const response = await fetch(
      `${this.config.telegramApiBase}/file/bot${this.config.telegramToken}/${file.file_path}`,
      {
        signal: AbortSignal.timeout(180_000),
      },
    );
    return { kind: "remote", response };
  }
}

export class TelegramHandler {
  constructor(
    private readonly config: ServerConfig,
    private readonly repository: TelegramRepository,
    private readonly telegram: TelegramTransport,
  ) {}

  async handle(update: TelegramUpdate): Promise<void> {
    if (update.callback_query)
      return this.handleCallback(update.callback_query);
    if (update.message) return this.handleMessage(update.message);
  }

  private async handleMessage(message: TelegramMessage): Promise<void> {
    if (!message.from) return;
    const telegramId = String(message.from.id);
    const displayName = [message.from.first_name, message.from.last_name]
      .filter(Boolean)
      .join(" ");
    if (message.text?.match(/^\/privacy(?:@\w+)?(?:\s|$)/i)) {
      await this.telegram.sendMessage(
        message.chat.id,
        `Política de privacidad de Naiskos: ${this.config.publicUrl}/privacidad`,
      );
      return;
    }
    const startPayload = message.text?.startsWith("/start")
      ? message.text.split(/\s+/, 2)[1]
      : undefined;
    if (startPayload?.startsWith("enroll_")) {
      await this.handleDeviceEnrollmentStart(
        message.chat.id,
        telegramId,
        startPayload.slice("enroll_".length),
      );
      return;
    }
    const pairingCode = extractPairingCode(message.text, startPayload);
    let user = await this.repository.findTelegramUser(telegramId);
    if (pairingCode) {
      user ??= await this.repository.upsertPendingTelegramUser(
        telegramId,
        displayName,
      );
      if (await this.replyIfRestricted(message.chat.id, user)) return;
      if (user.status !== "approved") {
        const claim = await this.repository.claimFrameByPairingCode(
          pairingCode,
          user.id,
        );
        if (!claim) {
          await this.telegram.sendMessage(
            message.chat.id,
            "El código del marco no es válido. Revísalo en Marco y equipo.",
          );
          return;
        }
        await this.requestGlobalApproval(
          message.chat.id,
          telegramId,
          displayName,
          claim.frameName,
        );
        return;
      }
      const frame = await this.repository.linkFrameByPairingCode(
        pairingCode,
        user.id,
      );
      await this.telegram.sendMessage(
        message.chat.id,
        frame
          ? `Quedaste vinculado al marco «${frame.frameName}». Ya puedes enviarle fotos y videos.`
          : "El código del marco no es válido. Revísalo en Marco y equipo.",
      );
      return;
    }
    if (message.text?.startsWith("/start")) {
      user ??= await this.repository.upsertPendingTelegramUser(
        telegramId,
        displayName,
      );
      if (await this.replyIfRestricted(message.chat.id, user)) return;
      const invitationCode = startPayload;
      if (user.status !== "approved") {
        const claimedInvitation = invitationCode
          ? await this.repository.claimInvitation(invitationCode, user.id)
          : null;
        if (invitationCode && !claimedInvitation) {
          await this.telegram.sendMessage(
            message.chat.id,
            "La invitación no existe, venció, ya fue utilizada o pertenece a otra solicitud.",
          );
        }
        await this.requestGlobalApproval(
          message.chat.id,
          telegramId,
          displayName,
          claimedInvitation?.frameName ?? null,
        );
        return;
      }
      if (invitationCode) {
        const invitation = await this.repository.consumeInvitation(
          invitationCode,
          user.id,
        );
        await this.telegram.sendMessage(
          message.chat.id,
          invitation
            ? `Autorización concedida para el marco «${invitation.frameName}».`
            : "La invitación no existe, venció o ya fue utilizada.",
        );
        return;
      }
      await this.telegram.sendMessage(
        message.chat.id,
        "Ya estás autorizado. Envíame una foto o video.",
      );
      return;
    }
    if (!user || user.status !== "approved") {
      user =
        user ??
        (await this.repository.upsertPendingTelegramUser(
          telegramId,
          displayName,
        ));
      if (await this.replyIfRestricted(message.chat.id, user)) return;
      await this.requestGlobalApproval(
        message.chat.id,
        telegramId,
        displayName,
        null,
      );
      return;
    }
    await this.receiveMedia(message, user, displayName);
  }

  private async handleDeviceEnrollmentStart(
    chatId: number,
    telegramId: string,
    code: string,
  ): Promise<void> {
    if (!this.config.telegramAdminIds.has(telegramId)) {
      await this.telegram.sendMessage(
        chatId,
        "Sólo un administrador de Naiskos puede aprobar un dispositivo.",
      );
      return;
    }
    const enrollment = await this.repository.findDeviceEnrollmentByClaimCode(code);
    if (!enrollment || enrollment.status !== "pending") {
      await this.telegram.sendMessage(
        chatId,
        "La solicitud del dispositivo no existe, venció o ya fue resuelta.",
      );
      return;
    }
    await this.telegram.sendMessage(
      chatId,
      `Alta de dispositivo solicitada:\n${enrollment.suggestedName}\n${enrollment.deviceModel}\n${enrollment.width} × ${enrollment.height}`,
      {
        inline_keyboard: [
          [
            {
              text: "Aprobar dispositivo",
              callback_data: `enroll-approve:${enrollment.requestId}`,
            },
            {
              text: "Rechazar",
              callback_data: `enroll-reject:${enrollment.requestId}`,
            },
          ],
        ],
      },
    );
  }

  private async requestGlobalApproval(
    chatId: number,
    telegramId: string,
    displayName: string,
    frameName: string | null,
  ): Promise<void> {
    await this.telegram.sendMessage(
      chatId,
      frameName
        ? `Tu solicitud para el marco «${frameName}» fue enviada al administrador. Te avisaré cuando sea aprobada.`
        : "Tu solicitud fue enviada al administrador. Te avisaré cuando sea aprobada.",
    );
    for (const adminId of this.config.telegramAdminIds) {
      await this.telegram.sendMessage(
        adminId,
        `Solicitud de acceso: ${displayName} (${telegramId})${
          frameName ? ` para el marco «${frameName}»` : ""
        }`,
        {
          inline_keyboard: [
            [
              { text: "Aprobar", callback_data: `approve:${telegramId}` },
              { text: "Rechazar", callback_data: `reject:${telegramId}` },
            ],
            [{ text: "Bloquear", callback_data: `block:${telegramId}` }],
          ],
        },
      );
    }
  }

  private async handleCallback(
    query: NonNullable<TelegramUpdate["callback_query"]>,
  ): Promise<void> {
    const actorId = String(query.from.id);
    if (!query.data) {
      await this.telegram.answerCallbackQuery(
        query.id,
        "Acción no autorizada.",
      );
      return;
    }
    const [action, targetId] = query.data.split(":", 2);
    if (
      (action === "enroll-approve" || action === "enroll-reject") &&
      targetId &&
      this.config.telegramAdminIds.has(actorId)
    ) {
      const result =
        action === "enroll-approve"
          ? await this.repository.approveDeviceEnrollment(targetId, actorId)
          : await this.repository.rejectDeviceEnrollment(targetId, actorId);
      await this.telegram.answerCallbackQuery(
        query.id,
        result.changed
          ? action === "enroll-approve"
            ? "Dispositivo aprobado."
            : "Solicitud rechazada."
          : "La solicitud venció o ya fue resuelta.",
      );
      if (result.changed) {
        await this.telegram.sendMessage(
          actorId,
          action === "enroll-approve"
            ? `Dispositivo «${result.frameName}» registrado correctamente.`
            : "La solicitud del dispositivo fue rechazada.",
        );
      }
      return;
    }
    if (
      action === "approve" &&
      targetId &&
      this.config.telegramAdminIds.has(actorId)
    ) {
      const approval = await this.repository.approveTelegramUser(
        targetId,
        actorId,
      );
      await this.telegram.answerCallbackQuery(
        query.id,
        approval.approved
          ? approval.grantedFrames.length
            ? "Usuario aprobado y vinculado al marco."
            : "Usuario aprobado."
          : "La solicitud ya cambió.",
      );
      if (approval.approved) {
        const frameNames = approval.grantedFrames.map((frame) => frame.frameName);
        await this.telegram.sendMessage(
          targetId,
          frameNames.length
            ? `Tu acceso a Naiskos fue aprobado y quedaste vinculado a ${formatFrameNames(frameNames)}.`
            : "Tu acceso a Naiskos fue aprobado. Usa el QR del marco para vincularte.",
        );
        await this.telegram.sendMessage(
          actorId,
          `Administrar acceso de ${targetId}:`,
          {
            inline_keyboard: [
              [
                { text: "Revocar", callback_data: `revoke:${targetId}` },
                { text: "Bloquear", callback_data: `block:${targetId}` },
              ],
            ],
          },
        );
      }
      return;
    }
    if (
      ["reject", "block", "unblock", "revoke", "reactivate"].includes(action ?? "") &&
      targetId &&
      this.config.telegramAdminIds.has(actorId)
    ) {
      const changed =
        action === "reject"
          ? await this.repository.rejectTelegramUser(targetId, actorId)
          : action === "block"
            ? await this.repository.blockTelegramUser(targetId, actorId)
            : action === "unblock"
              ? await this.repository.unblockTelegramUser(targetId, actorId)
              : action === "revoke"
                ? await this.repository.revokeTelegramUser(targetId, actorId)
                : await this.repository.reactivateTelegramUser(targetId, actorId);
      await this.telegram.answerCallbackQuery(
        query.id,
        changed ? lifecycleAdminMessage(action!) : "El estado ya cambió.",
      );
      if (changed) {
        await this.telegram.sendMessage(targetId, lifecycleUserMessage(action!));
        if (action === "block") {
          await this.telegram.sendMessage(actorId, `Usuario ${targetId} bloqueado.`, {
            inline_keyboard: [
              [{ text: "Desbloquear", callback_data: `unblock:${targetId}` }],
            ],
          });
        } else if (action === "revoke") {
          await this.telegram.sendMessage(actorId, `Usuario ${targetId} revocado.`, {
            inline_keyboard: [
              [{ text: "Permitir nueva solicitud", callback_data: `reactivate:${targetId}` }],
            ],
          });
        }
      }
      return;
    }
    if (action === "sel") {
      const [, code, command] = query.data.split(":", 3);
      const user = await this.repository.findTelegramUser(actorId);
      if (!user || user.status !== "approved" || !code || !command) {
        await this.telegram.answerCallbackQuery(
          query.id,
          "Selección no autorizada.",
        );
        return;
      }
      const result = await this.repository.updatePendingSelection(
        code,
        user.id,
        command === "all" ? "all" : command === "done" ? "done" : "toggle",
        /^\d+$/.test(command) ? Number(command) : undefined,
      );
      if (result.state === "completed" && result.payload) {
        await this.repository.enqueueIngest(result.payload);
        await this.telegram.answerCallbackQuery(
          query.id,
          `Enviado a ${result.count} marco(s).`,
        );
      } else if (result.state === "updated") {
        await this.telegram.answerCallbackQuery(
          query.id,
          `${result.count} marco(s) seleccionado(s).`,
        );
      } else if (result.state === "empty") {
        await this.telegram.answerCallbackQuery(
          query.id,
          "Selecciona al menos un marco.",
        );
      } else {
        await this.telegram.answerCallbackQuery(
          query.id,
          "La selección venció o ya fue utilizada.",
        );
      }
      return;
    }
    await this.telegram.answerCallbackQuery(
      query.id,
      "Acción todavía no implementada.",
    );
  }

  private async receiveMedia(
    message: TelegramMessage,
    user: TelegramUser,
    senderName: string,
  ): Promise<void> {
    const frames = await this.repository.accessibleFrames(user.id);
    if (frames.length === 0) {
      await this.telegram.sendMessage(
        message.chat.id,
        "No tienes acceso a ningún marco. Escanea primero su QR.",
      );
      return;
    }
    const payload = extractMedia(
      message,
      user.id,
      senderName,
      frames.length === 1 ? [frames[0]!.id] : [],
    );
    if (!payload) {
      await this.telegram.sendMessage(
        message.chat.id,
        "Envía una fotografía o un video. Como documento conservará mejor calidad.",
      );
      return;
    }
    if (payload.kind === "video" && (payload.durationSeconds ?? 0) > 120) {
      await this.telegram.sendMessage(
        message.chat.id,
        "El video supera el límite de 2 minutos y no fue aceptado.",
      );
      return;
    }
    if (frames.length > 1) {
      const code = await this.repository.createPendingSelection(
        user.id,
        payload,
        frames.map((frame) => frame.id),
      );
      const buttons = frames.map((frame, index) => [
        { text: frame.name, callback_data: `sel:${code}:${index}` },
      ]);
      buttons.push([
        { text: "Todos", callback_data: `sel:${code}:all` },
        { text: "Confirmar selección", callback_data: `sel:${code}:done` },
      ]);
      await this.telegram.sendMessage(
        message.chat.id,
        "Elige uno o varios marcos —«Todos» los marca todos— y luego pulsa «Confirmar selección».",
        { inline_keyboard: buttons },
      );
      return;
    }
    await this.repository.enqueueIngest(payload);
    await this.telegram.sendMessage(
      message.chat.id,
      `Recibido para «${frames[0]!.name}». Te avisaré cuando esté listo.`,
    );
  }

  private async replyIfRestricted(
    chatId: number,
    user: TelegramUser,
  ): Promise<boolean> {
    if (user.status === "blocked") {
      await this.telegram.sendMessage(
        chatId,
        "Tu acceso a Naiskos está bloqueado. Contacta al administrador.",
      );
      return true;
    }
    if (user.status === "revoked") {
      await this.telegram.sendMessage(
        chatId,
        "Tu acceso fue revocado. El administrador debe permitir una nueva solicitud.",
      );
      return true;
    }
    return false;
  }
}

function extractPairingCode(
  text: string | undefined,
  startPayload: string | undefined,
): string | null {
  const candidate = startPayload?.startsWith("frame_")
    ? startPayload.slice("frame_".length)
    : text?.match(/^\/vincular(?:@\w+)?\s+(.+)$/i)?.[1] ??
      text?.match(/^([A-HJ-NP-Z2-9]{4}(?:-[A-HJ-NP-Z2-9]{4}){2})$/i)?.[1];
  if (!candidate) return null;
  const normalized = candidate.toUpperCase().replace(/[-\s]/g, "");
  return /^[A-HJ-NP-Z2-9]{12}$/.test(normalized) ? normalized : null;
}

function formatFrameNames(names: string[]): string {
  const quoted = names.map((name) => `«${name}»`);
  if (quoted.length === 1) return quoted[0]!;
  return `${quoted.slice(0, -1).join(", ")} y ${quoted.at(-1)}`;
}

function lifecycleAdminMessage(action: string): string {
  return (
    {
      reject: "Solicitud rechazada.",
      block: "Usuario bloqueado.",
      unblock: "Usuario desbloqueado; deberá ser aprobado nuevamente.",
      revoke: "Acceso global revocado.",
      reactivate: "El usuario puede presentar una nueva solicitud.",
    }[action] ?? "Estado actualizado."
  );
}

function lifecycleUserMessage(action: string): string {
  return (
    {
      reject: "Tu solicitud de acceso a Naiskos fue rechazada. Puedes solicitar acceso nuevamente.",
      block: "Tu acceso a Naiskos fue bloqueado.",
      unblock: "Tu bloqueo fue retirado. Inicia nuevamente el bot para solicitar aprobación.",
      revoke: "Tu acceso a Naiskos y a sus marcos fue revocado.",
      reactivate: "Ya puedes iniciar nuevamente el bot y presentar una solicitud.",
    }[action] ?? "Tu estado de acceso cambió."
  );
}

export function extractMedia(
  message: TelegramMessage,
  telegramUserId: string,
  senderName: string,
  frameIds: string[],
): IngestJobPayload | null {
  const largestPhoto = message.photo?.toSorted(
    (a, b) => (b.file_size ?? 0) - (a.file_size ?? 0),
  )[0];
  if (largestPhoto) {
    return {
      chatId: String(message.chat.id),
      telegramFileId: largestPhoto.file_id,
      telegramFileUniqueId: largestPhoto.file_unique_id,
      kind: "photo",
      mimeType: "image/jpeg",
      originalName: null,
      sizeBytes: largestPhoto.file_size ?? null,
      durationSeconds: null,
      caption: message.caption ?? null,
      senderName,
      telegramUserId,
      frameIds,
    };
  }
  if (message.video) {
    return {
      chatId: String(message.chat.id),
      telegramFileId: message.video.file_id,
      telegramFileUniqueId: message.video.file_unique_id,
      kind: "video",
      mimeType: message.video.mime_type ?? "video/mp4",
      originalName: message.video.file_name ?? null,
      sizeBytes: message.video.file_size ?? null,
      durationSeconds: message.video.duration,
      caption: message.caption ?? null,
      senderName,
      telegramUserId,
      frameIds,
    };
  }
  const document = message.document;
  const supportedPhotoDocuments = new Set([
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/heic",
    "image/heif",
  ]);
  const supportedVideoDocuments = new Set([
    "video/mp4",
    "video/quicktime",
    "video/webm",
    "video/x-matroska",
  ]);
  if (
    document?.mime_type &&
    (supportedPhotoDocuments.has(document.mime_type) ||
      supportedVideoDocuments.has(document.mime_type))
  ) {
    return {
      chatId: String(message.chat.id),
      telegramFileId: document.file_id,
      telegramFileUniqueId: document.file_unique_id,
      kind: supportedPhotoDocuments.has(document.mime_type) ? "photo" : "video",
      mimeType: document.mime_type,
      originalName: document.file_name ?? null,
      sizeBytes: document.file_size ?? null,
      durationSeconds: null,
      caption: message.caption ?? null,
      senderName,
      telegramUserId,
      frameIds,
    };
  }
  return null;
}
