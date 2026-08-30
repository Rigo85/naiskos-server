import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { parseAdminCommand } from "../src/admin/cli.js";
import {
  CreateFrameRecord,
  CreateInvitationRecord,
  FrameSummary,
  invitationQrPng,
  ProvisioningService,
  ProvisioningStore,
  RotateTokenRecord,
  writeInvitationQr,
} from "../src/admin/provisioning.js";

class MemoryStore implements ProvisioningStore {
  createdFrame: CreateFrameRecord | null = null;
  rotatedToken: RotateTokenRecord | null = null;
  invitation: CreateInvitationRecord | null = null;
  frames: FrameSummary[] = [];
  revokeResult = true;

  async createFrame(record: CreateFrameRecord): Promise<void> {
    this.createdFrame = record;
  }

  async listFrames(): Promise<FrameSummary[]> {
    return this.frames;
  }

  async rotateToken(
    record: RotateTokenRecord,
  ): Promise<{ frameName: string; revokedCount: number }> {
    this.rotatedToken = record;
    return { frameName: "Sala", revokedCount: 1 };
  }

  async revokeToken(): Promise<boolean> {
    return this.revokeResult;
  }

  async createInvitation(
    record: CreateInvitationRecord,
  ): Promise<{ frameName: string }> {
    this.invitation = record;
    return { frameName: "Sala" };
  }
}

describe("aprovisionamiento", () => {
  it("crea un marco y entrega el token una sola vez, almacenando sólo su hash", async () => {
    const store = new MemoryStore();
    const service = new ProvisioningService(store, "@naiskosbot");
    const result = await service.createFrame({ name: "  Sala   principal  " });

    expect(result.name).toBe("Sala principal");
    expect(result.width).toBe(1280);
    expect(result.height).toBe(800);
    expect(Buffer.from(result.agentToken, "base64url")).toHaveLength(32);
    expect(store.createdFrame?.tokenHash).toHaveLength(32);
    expect(store.createdFrame?.tokenHash.toString("utf8")).not.toContain(
      result.agentToken,
    );
  });

  it("rota una credencial con un token nuevo", async () => {
    const store = new MemoryStore();
    const service = new ProvisioningService(store, "naiskosbot");
    const result = await service.rotateToken({
      frameId: "e410e4df-7e9a-4e18-a088-56a775c1b74e",
    });
    expect(result.frameName).toBe("Sala");
    expect(result.revokedCount).toBe(1);
    expect(store.rotatedToken?.tokenHash).toHaveLength(32);
  });

  it("crea una invitación opaca de un solo uso con vencimiento y deep link", async () => {
    const store = new MemoryStore();
    const now = new Date("2026-08-28T20:00:00.000Z");
    const service = new ProvisioningService(store, "@naiskosbot", () => now);
    const result = await service.createInvitation({
      frameId: "e410e4df-7e9a-4e18-a088-56a775c1b74e",
      expiresInHours: 24,
    });
    expect(result.deepLink).toBe(`https://t.me/naiskosbot?start=${result.code}`);
    expect(result.expiresAt).toBe("2026-08-29T20:00:00.000Z");
    expect(result.code).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(store.invitation?.codeHash).toHaveLength(32);
    expect(store.invitation?.codeHash.toString("utf8")).not.toContain(result.code);
  });

  it("genera un QR PNG de 640 píxeles y no sobrescribe otro archivo", async () => {
    const link = "https://t.me/naiskosbot?start=abc123";
    const png = await invitationQrPng(link);
    expect((await sharp(png).metadata()).width).toBe(640);

    const directory = await mkdtemp(path.join(os.tmpdir(), "naiskos-qr-test-"));
    const destination = path.join(directory, "invite.png");
    try {
      await writeInvitationQr(link, destination);
      expect((await readFile(destination)).subarray(1, 4).toString()).toBe("PNG");
      await expect(writeInvitationQr(link, destination)).rejects.toMatchObject({
        code: "EEXIST",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rechaza dimensiones, UUID y vencimientos fuera de contrato", async () => {
    const service = new ProvisioningService(new MemoryStore(), "naiskosbot");
    await expect(
      service.createFrame({ name: "Sala", width: 0 }),
    ).rejects.toThrow("width");
    await expect(
      service.rotateToken({ frameId: "no-es-uuid" }),
    ).rejects.toThrow("UUID");
    await expect(
      service.createInvitation({
        frameId: "e410e4df-7e9a-4e18-a088-56a775c1b74e",
        expiresInHours: 1000,
      }),
    ).rejects.toThrow("expires-hours");
  });
});

describe("CLI administrativa", () => {
  it("interpreta la creación de un marco", () => {
    expect(
      parseAdminCommand([
        "frame:create",
        "--name",
        "Sala",
        "--width",
        "1280",
        "--height",
        "800",
      ]),
    ).toEqual({
      kind: "frame:create",
      name: "Sala",
      width: 1280,
      height: 800,
      tokenLabel: "primary",
      json: false,
    });
  });

  it("exige los argumentos obligatorios", () => {
    expect(() => parseAdminCommand(["token:revoke", "--frame-id", "x"])).toThrow(
      "--token-id",
    );
  });
});
