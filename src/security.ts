import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function generateOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

export function tokenHash(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

export function verifyWebhookSecret(
  provided: string | undefined,
  expected: string | null,
): boolean {
  if (!provided || !expected) return false;
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function verifyOpaqueSecret(
  provided: string | undefined,
  expected: string | null,
): boolean {
  return verifyWebhookSecret(provided, expected);
}
