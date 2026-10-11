import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import request from "supertest";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Express } from "express";
import { createDb, type Db } from "../db/client";
import { discogsTokens } from "../db/schema";
import { DiscogsAuthError, DiscogsTransientError } from "../discogs-client";
import { DiscogsQueue } from "../queue/discogs-queue";
import { createApp } from "../app";
import { decryptToken } from "../util/token-crypto";

const { verifyIdToken } = vi.hoisted(() => ({ verifyIdToken: vi.fn() }));

vi.mock("firebase-admin/app", () => ({
  cert: vi.fn(),
  getApps: vi.fn(() => []),
  initializeApp: vi.fn(),
}));

vi.mock("firebase-admin/auth", () => ({
  getAuth: vi.fn(() => ({ verifyIdToken })),
}));

function asUser(app: Express, uid: string) {
  verifyIdToken.mockResolvedValue({ uid, email: "dp.ceolpan@gmail.com" });
  const agent = request(app);
  const auth = { Authorization: "Bearer test-token" };
  return {
    get: (url: string) => agent.get(url).set(auth),
    put: (url: string) => agent.put(url).set(auth),
    delete: (url: string) => agent.delete(url).set(auth),
  };
}

describe("discogs token", () => {
  let dbPath: string;
  let db: Db;
  let queue: DiscogsQueue;
  let app: Express;
  let getIdentity: Mock<(token: string) => Promise<{ id: number; username: string }>>;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `fader-test-${Date.now()}-${Math.random()}.sqlite`);
    db = createDb(dbPath);
    migrate(db, { migrationsFolder: "./drizzle" });
    queue = new DiscogsQueue(db);
    getIdentity = vi.fn(async () => ({ id: 1, username: "dan" }));
    app = createApp({ db, queue, getIdentity });

    process.env.FIREBASE_PROJECT_ID = "test-project";
    process.env.FIREBASE_CLIENT_EMAIL = "test@test-project.iam.gserviceaccount.com";
    process.env.FIREBASE_PRIVATE_KEY = "test-key";
    process.env.ALLOWED_EMAILS = "dp.ceolpan@gmail.com";
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    verifyIdToken.mockReset();
  });

  afterEach(() => {
    delete process.env.TOKEN_ENCRYPTION_KEY;
    queue.stop();
    db.$client.close();
    for (const suffix of ["", "-journal", "-wal", "-shm"]) {
      fs.rmSync(dbPath + suffix, { force: true });
    }
  });

  it("requires a signed-in user", async () => {
    expect((await request(app).get("/settings/discogs-token")).status).toBe(401);
  });

  it("starts with no token", async () => {
    const res = await asUser(app, "u1").get("/settings/discogs-token");

    expect(res.body).toEqual({ set: false, username: null });
  });

  describe("PUT", () => {
    it("checks the token with Discogs, stores it encrypted and never returns it", async () => {
      const res = await asUser(app, "u1").put("/settings/discogs-token").send({ token: "  abc123  " });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ set: true, username: "dan" });
      expect(JSON.stringify(res.body)).not.toContain("abc123");
      expect(getIdentity).toHaveBeenCalledWith("abc123");

      const row = db.select().from(discogsTokens).get()!;
      expect(row.tokenEncrypted).not.toContain("abc123");
      expect(decryptToken(row.tokenEncrypted)).toBe("abc123");

      const read = await asUser(app, "u1").get("/settings/discogs-token");
      expect(read.body).toEqual({ set: true, username: "dan" });
      expect(JSON.stringify(read.body)).not.toContain("abc123");
    });

    it("replaces an earlier token", async () => {
      await asUser(app, "u1").put("/settings/discogs-token").send({ token: "first" });
      getIdentity.mockResolvedValue({ id: 2, username: "dan2" });

      const res = await asUser(app, "u1").put("/settings/discogs-token").send({ token: "second" });

      expect(res.body).toEqual({ set: true, username: "dan2" });
      const rows = db.select().from(discogsTokens).all();
      expect(rows).toHaveLength(1);
      expect(decryptToken(rows[0]!.tokenEncrypted)).toBe("second");
    });

    it("keeps each collector's token separate", async () => {
      await asUser(app, "u1").put("/settings/discogs-token").send({ token: "first" });

      const res = await asUser(app, "u2").get("/settings/discogs-token");

      expect(res.body).toEqual({ set: false, username: null });
    });

    it("rejects a token Discogs does not accept, and stores nothing", async () => {
      getIdentity.mockRejectedValue(new DiscogsAuthError("nope"));

      const res = await asUser(app, "u1").put("/settings/discogs-token").send({ token: "bad" });

      expect(res.status).toBe(400);
      expect(db.select().from(discogsTokens).all()).toEqual([]);
    });

    it("answers 502 when Discogs cannot be reached, and stores nothing", async () => {
      getIdentity.mockRejectedValue(new DiscogsTransientError("down"));

      const res = await asUser(app, "u1").put("/settings/discogs-token").send({ token: "abc" });

      expect(res.status).toBe(502);
      expect(db.select().from(discogsTokens).all()).toEqual([]);
    });

    it.each([[{}], [{ token: "" }], [{ token: "   " }], [{ token: 5 }], [{ token: "x".repeat(201) }]])(
      "rejects %j with 400 without asking Discogs",
      async (body) => {
        const res = await asUser(app, "u1").put("/settings/discogs-token").send(body);

        expect(res.status).toBe(400);
        expect(getIdentity).not.toHaveBeenCalled();
      },
    );

    it("answers 503 when the server has no encryption key, without asking Discogs", async () => {
      delete process.env.TOKEN_ENCRYPTION_KEY;

      const res = await asUser(app, "u1").put("/settings/discogs-token").send({ token: "abc" });

      expect(res.status).toBe(503);
      expect(getIdentity).not.toHaveBeenCalled();
      expect(db.select().from(discogsTokens).all()).toEqual([]);
    });
  });

  describe("DELETE", () => {
    it("removes the token, and is fine when there is none", async () => {
      await asUser(app, "u1").put("/settings/discogs-token").send({ token: "abc" });

      expect((await asUser(app, "u1").delete("/settings/discogs-token")).status).toBe(204);
      expect((await asUser(app, "u1").delete("/settings/discogs-token")).status).toBe(204);

      const res = await asUser(app, "u1").get("/settings/discogs-token");
      expect(res.body).toEqual({ set: false, username: null });
    });

    it("leaves another collector's token alone", async () => {
      await asUser(app, "u2").put("/settings/discogs-token").send({ token: "abc" });

      await asUser(app, "u1").delete("/settings/discogs-token");

      const res = await asUser(app, "u2").get("/settings/discogs-token");
      expect(res.body.set).toBe(true);
    });
  });
});
