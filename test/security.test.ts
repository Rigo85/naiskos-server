import { describe, expect, it } from "vitest";

import {
  generateOpaqueToken,
  tokenHash,
  verifyWebhookSecret,
} from "../src/security.js";

describe("tokens de agente", () => {
  it("genera 256 bits y almacena solamente su hash", () => {
    const token = generateOpaqueToken();
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    expect(tokenHash(token)).toHaveLength(32);
  });
});

describe("secreto del webhook", () => {
  it("compara exactamente y rechaza ausencias", () => {
    expect(verifyWebhookSecret("secreto", "secreto")).toBe(true);
    expect(verifyWebhookSecret("otro", "secreto")).toBe(false);
    expect(verifyWebhookSecret(undefined, "secreto")).toBe(false);
  });
});
