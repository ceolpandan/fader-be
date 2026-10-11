import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptToken, encryptToken, tokenKeyAvailable, TokenKeyError } from "./token-crypto";

const env = (key = randomBytes(32).toString("base64")) => ({ TOKEN_ENCRYPTION_KEY: key }) as NodeJS.ProcessEnv;

describe("token crypto", () => {
  it("round-trips a token and never stores it in the clear", () => {
    const e = env();

    const stored = encryptToken("secret-token", e);

    expect(stored).not.toContain("secret-token");
    expect(decryptToken(stored, e)).toBe("secret-token");
  });

  it("encrypts the same token differently each time", () => {
    const e = env();

    expect(encryptToken("t", e)).not.toBe(encryptToken("t", e));
  });

  it("cannot be decrypted with another key or after tampering", () => {
    const stored = encryptToken("secret-token", env());

    expect(() => decryptToken(stored, env())).toThrow();
    const e = env();
    const [version, iv, tag, data] = encryptToken("secret-token", e).split(".") as [string, string, string, string];
    const flipped = Buffer.from(data, "base64");
    flipped[0] = flipped[0]! ^ 1;
    expect(() => decryptToken([version, iv, tag, flipped.toString("base64")].join("."), e)).toThrow();
  });

  it("refuses to work without a well formed key", () => {
    expect(() => encryptToken("t", {} as NodeJS.ProcessEnv)).toThrow(TokenKeyError);
    expect(() => encryptToken("t", env("c2hvcnQ="))).toThrow(TokenKeyError);
    expect(tokenKeyAvailable({} as NodeJS.ProcessEnv)).toBe(false);
    expect(tokenKeyAvailable(env("c2hvcnQ="))).toBe(false);
    expect(tokenKeyAvailable(env())).toBe(true);
  });
});
