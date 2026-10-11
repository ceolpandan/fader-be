import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";
const KEY_BYTES = 32;

/** The encryption key is missing or is not 32 bytes of base64. */
export class TokenKeyError extends Error {}

/** Reads `TOKEN_ENCRYPTION_KEY` (32 random bytes, base64). Generate one with `openssl rand -base64 32`. */
function loadKey(env: NodeJS.ProcessEnv): Buffer {
  const raw = env.TOKEN_ENCRYPTION_KEY?.trim();
  if (!raw) throw new TokenKeyError("TOKEN_ENCRYPTION_KEY is not set");
  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_BYTES) {
    throw new TokenKeyError(`TOKEN_ENCRYPTION_KEY must be ${KEY_BYTES} bytes, base64 encoded`);
  }
  return key;
}

/** Whether tokens can be stored: the key is set and well formed. */
export function tokenKeyAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    loadKey(env);
    return true;
  } catch {
    return false;
  }
}

/** AES-256-GCM, as `v1.<iv>.<tag>.<ciphertext>` (base64 parts), so a changed key or value fails to decrypt. */
export function encryptToken(plain: string, env: NodeJS.ProcessEnv = process.env): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", loadKey(env), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [VERSION, iv, cipher.getAuthTag(), data].map((part) => (typeof part === "string" ? part : part.toString("base64"))).join(".");
}

export function decryptToken(stored: string, env: NodeJS.ProcessEnv = process.env): string {
  const [version, iv, tag, data] = stored.split(".");
  if (version !== VERSION || !iv || !tag || data === undefined) throw new Error("Unrecognised token format");
  const decipher = createDecipheriv("aes-256-gcm", loadKey(env), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
}
