import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import QRCode from "qrcode";

import { Database, transaction } from "../db.js";
import { generateOpaqueToken, tokenHash } from "../security.js";

const FRAME_NAME_MAX_LENGTH = 120;
const TOKEN_LABEL_MAX_LENGTH = 80;
const MAX_DIMENSION = 16_384;
const MAX_INVITATION_HOURS = 168;

export interface FrameSummary {
  id: string;
  name: string;
  status: "provisioning" | "active" | "disabled";
  width: number;
  height: number;
  manifestVersion: number;
  activeTokenCount: number;
  installedVersion: number | null;
  agentState: string | null;
  lastSeenAt: string | null;
}

export interface CreateFrameRecord {
  frameId: string;
  name: string;
  width: number;
  height: number;
  tokenId: string;
  tokenHash: Buffer;
  tokenLabel: string;
}

export interface RotateTokenRecord {
  frameId: string;
  tokenId: string;
  tokenHash: Buffer;
  tokenLabel: string;
}

export interface CreateInvitationRecord {
  invitationId: string;
  frameId: string;
  codeHash: Buffer;
  expiresAt: Date;
}

export interface ProvisioningStore {
  createFrame(record: CreateFrameRecord): Promise<void>;
  listFrames(): Promise<FrameSummary[]>;
  rotateToken(
    record: RotateTokenRecord,
  ): Promise<{ frameName: string; revokedCount: number } | null>;
  revokeToken(frameId: string, tokenId: string): Promise<boolean>;
  createInvitation(
    record: CreateInvitationRecord,
  ): Promise<{ frameName: string } | null>;
}

export class PostgresProvisioningStore implements ProvisioningStore {
  constructor(private readonly database: Database) {}

  async createFrame(record: CreateFrameRecord): Promise<void> {
    await transaction(this.database, async (client) => {
      await client.query(
        `INSERT INTO naiskos.frames (id, name, status, width, height)
         VALUES ($1, $2, 'active', $3, $4)`,
        [record.frameId, record.name, record.width, record.height],
      );
      await client.query(
        `INSERT INTO naiskos.agent_tokens (id, frame_id, token_hash, label)
         VALUES ($1, $2, $3, $4)`,
        [record.tokenId, record.frameId, record.tokenHash, record.tokenLabel],
      );
      await audit(client, record.frameId, "frame.created", {
        name: record.name,
        width: record.width,
        height: record.height,
        tokenId: record.tokenId,
        tokenLabel: record.tokenLabel,
      });
    });
  }

  async listFrames(): Promise<FrameSummary[]> {
    const result = await this.database.query<{
      id: string;
      name: string;
      status: FrameSummary["status"];
      width: number;
      height: number;
      manifestVersion: string;
      activeTokenCount: string;
      installedVersion: string | null;
      agentState: string | null;
      lastSeenAt: Date | null;
    }>(
      `SELECT f.id, f.name, f.status, f.width, f.height,
              f.manifest_version::text AS "manifestVersion",
              count(t.id) FILTER (WHERE t.revoked_at IS NULL)::text AS "activeTokenCount",
              r.installed_version::text AS "installedVersion",
              r.agent_state AS "agentState", r.last_seen_at AS "lastSeenAt"
         FROM naiskos.frames f
         LEFT JOIN naiskos.agent_tokens t ON t.frame_id = f.id
         LEFT JOIN naiskos.frame_runtime r ON r.frame_id = f.id
        GROUP BY f.id, r.installed_version, r.agent_state, r.last_seen_at
        ORDER BY f.created_at, f.id`,
    );
    return result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      status: row.status,
      width: row.width,
      height: row.height,
      manifestVersion: Number(row.manifestVersion),
      activeTokenCount: Number(row.activeTokenCount),
      installedVersion:
        row.installedVersion === null ? null : Number(row.installedVersion),
      agentState: row.agentState,
      lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    }));
  }

  async rotateToken(
    record: RotateTokenRecord,
  ): Promise<{ frameName: string; revokedCount: number } | null> {
    return transaction(this.database, async (client) => {
      const frame = await client.query<{ name: string }>(
        "SELECT name FROM naiskos.frames WHERE id=$1 FOR UPDATE",
        [record.frameId],
      );
      if (!frame.rows[0]) return null;
      const revoked = await client.query(
        `UPDATE naiskos.agent_tokens SET revoked_at=now()
          WHERE frame_id=$1 AND revoked_at IS NULL`,
        [record.frameId],
      );
      await client.query(
        `INSERT INTO naiskos.agent_tokens (id, frame_id, token_hash, label)
         VALUES ($1, $2, $3, $4)`,
        [record.tokenId, record.frameId, record.tokenHash, record.tokenLabel],
      );
      await audit(client, record.frameId, "frame.token.rotated", {
        tokenId: record.tokenId,
        tokenLabel: record.tokenLabel,
        revokedCount: revoked.rowCount ?? 0,
      });
      return {
        frameName: frame.rows[0].name,
        revokedCount: revoked.rowCount ?? 0,
      };
    });
  }

  async revokeToken(frameId: string, tokenId: string): Promise<boolean> {
    return transaction(this.database, async (client) => {
      const result = await client.query(
        `UPDATE naiskos.agent_tokens SET revoked_at=now()
          WHERE id=$1 AND frame_id=$2 AND revoked_at IS NULL`,
        [tokenId, frameId],
      );
      if (!result.rowCount) return false;
      await audit(client, frameId, "frame.token.revoked", { tokenId });
      return true;
    });
  }

  async createInvitation(
    record: CreateInvitationRecord,
  ): Promise<{ frameName: string } | null> {
    return transaction(this.database, async (client) => {
      const frame = await client.query<{ name: string }>(
        `SELECT name FROM naiskos.frames
          WHERE id=$1 AND status='active' FOR UPDATE`,
        [record.frameId],
      );
      if (!frame.rows[0]) return null;
      await client.query(
        `INSERT INTO naiskos.frame_invitations
           (id, frame_id, code_hash, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [
          record.invitationId,
          record.frameId,
          record.codeHash,
          record.expiresAt,
        ],
      );
      await audit(client, record.frameId, "frame.invitation.created", {
        invitationId: record.invitationId,
        expiresAt: record.expiresAt.toISOString(),
      });
      return { frameName: frame.rows[0].name };
    });
  }
}

export class ProvisioningService {
  private readonly botUsername: string;

  constructor(
    private readonly store: ProvisioningStore,
    botUsername: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.botUsername = normalizeBotUsername(botUsername);
  }

  async createFrame(input: {
    name: string;
    width?: number;
    height?: number;
    tokenLabel?: string;
  }): Promise<{
    frameId: string;
    name: string;
    width: number;
    height: number;
    tokenId: string;
    agentToken: string;
  }> {
    const name = normalizeFrameName(input.name);
    const width = validateInteger("width", input.width ?? 1280, 1, MAX_DIMENSION);
    const height = validateInteger("height", input.height ?? 800, 1, MAX_DIMENSION);
    const tokenLabel = normalizeTokenLabel(input.tokenLabel ?? "primary");
    const frameId = randomUUID();
    const tokenId = randomUUID();
    const agentToken = generateOpaqueToken();
    await this.store.createFrame({
      frameId,
      name,
      width,
      height,
      tokenId,
      tokenHash: tokenHash(agentToken),
      tokenLabel,
    });
    return { frameId, name, width, height, tokenId, agentToken };
  }

  listFrames(): Promise<FrameSummary[]> {
    return this.store.listFrames();
  }

  async rotateToken(input: {
    frameId: string;
    tokenLabel?: string;
  }): Promise<{
    frameId: string;
    frameName: string;
    tokenId: string;
    agentToken: string;
    revokedCount: number;
  }> {
    const frameId = validateUuid("frame-id", input.frameId);
    const tokenLabel = normalizeTokenLabel(input.tokenLabel ?? "primary");
    const tokenId = randomUUID();
    const agentToken = generateOpaqueToken();
    const result = await this.store.rotateToken({
      frameId,
      tokenId,
      tokenHash: tokenHash(agentToken),
      tokenLabel,
    });
    if (!result) throw new Error(`No existe el marco ${frameId}.`);
    return { frameId, tokenId, agentToken, ...result };
  }

  async revokeToken(input: {
    frameId: string;
    tokenId: string;
  }): Promise<void> {
    const frameId = validateUuid("frame-id", input.frameId);
    const tokenId = validateUuid("token-id", input.tokenId);
    if (!(await this.store.revokeToken(frameId, tokenId))) {
      throw new Error("El token no existe, pertenece a otro marco o ya fue revocado.");
    }
  }

  async createInvitation(input: {
    frameId: string;
    expiresInHours?: number;
  }): Promise<{
    invitationId: string;
    frameId: string;
    frameName: string;
    code: string;
    deepLink: string;
    expiresAt: string;
  }> {
    const frameId = validateUuid("frame-id", input.frameId);
    const expiresInHours = validateInteger(
      "expires-hours",
      input.expiresInHours ?? 24,
      1,
      MAX_INVITATION_HOURS,
    );
    const invitationId = randomUUID();
    const code = randomBytes(18).toString("base64url");
    const expiresAt = new Date(
      this.now().getTime() + expiresInHours * 60 * 60 * 1000,
    );
    const result = await this.store.createInvitation({
      invitationId,
      frameId,
      codeHash: tokenHash(code),
      expiresAt,
    });
    if (!result) {
      throw new Error(`El marco ${frameId} no existe o no está activo.`);
    }
    return {
      invitationId,
      frameId,
      frameName: result.frameName,
      code,
      deepLink: `https://t.me/${this.botUsername}?start=${code}`,
      expiresAt: expiresAt.toISOString(),
    };
  }
}

export async function invitationQrPng(deepLink: string): Promise<Buffer> {
  if (!deepLink.startsWith("https://t.me/")) {
    throw new Error("El enlace de invitación no pertenece a Telegram.");
  }
  return QRCode.toBuffer(deepLink, {
    type: "png",
    errorCorrectionLevel: "M",
    width: 640,
    margin: 4,
    color: { dark: "#050505", light: "#f7f5ef" },
  });
}

export async function writeInvitationQr(
  deepLink: string,
  outputPath: string,
): Promise<string> {
  const destination = path.resolve(outputPath);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, await invitationQrPng(deepLink), {
    flag: "wx",
    mode: 0o600,
  });
  return destination;
}

function normalizeFrameName(value: string): string {
  const name = value.trim().replace(/\s+/g, " ");
  if (name.length < 1 || name.length > FRAME_NAME_MAX_LENGTH) {
    throw new Error(`name debe tener entre 1 y ${FRAME_NAME_MAX_LENGTH} caracteres.`);
  }
  return name;
}

function normalizeTokenLabel(value: string): string {
  const label = value.trim();
  if (label.length < 1 || label.length > TOKEN_LABEL_MAX_LENGTH) {
    throw new Error(
      `token-label debe tener entre 1 y ${TOKEN_LABEL_MAX_LENGTH} caracteres.`,
    );
  }
  return label;
}

function validateInteger(
  name: string,
  value: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} debe ser un entero entre ${minimum} y ${maximum}.`);
  }
  return value;
}

function validateUuid(name: string, value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`${name} debe ser un UUID válido.`);
  }
  return value.toLowerCase();
}

function normalizeBotUsername(value: string): string {
  const username = value.trim().replace(/^@/, "");
  if (
    !/^[a-z0-9_]{5,32}$/i.test(username) ||
    !username.toLowerCase().endsWith("bot")
  ) {
    throw new Error("El username de Telegram debe tener 5–32 caracteres y terminar en bot.");
  }
  return username;
}

async function audit(
  client: { query: (text: string, values?: unknown[]) => Promise<unknown> },
  frameId: string,
  action: string,
  details: object,
): Promise<void> {
  await client.query(
    `INSERT INTO naiskos.audit_log (frame_id, action, details)
     VALUES ($1, $2, $3)`,
    [frameId, action, JSON.stringify(details)],
  );
}
