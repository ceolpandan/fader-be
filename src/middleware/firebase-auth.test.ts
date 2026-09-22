import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { firebaseAuth } from "./firebase-auth";

const { verifyIdToken } = vi.hoisted(() => ({ verifyIdToken: vi.fn() }));

vi.mock("firebase-admin/app", () => ({
  cert: vi.fn(),
  getApps: vi.fn(() => []),
  initializeApp: vi.fn(),
}));

vi.mock("firebase-admin/auth", () => ({
  getAuth: vi.fn(() => ({ verifyIdToken })),
}));

function buildApp() {
  const app = express();
  app.use(firebaseAuth);
  app.get("/protected", (req, res) => {
    res.json({ user: req.user });
  });
  return app;
}

describe("firebaseAuth middleware", () => {
  beforeEach(() => {
    verifyIdToken.mockReset();
    process.env.FIREBASE_PROJECT_ID = "test-project";
    process.env.FIREBASE_CLIENT_EMAIL = "test@test-project.iam.gserviceaccount.com";
    process.env.FIREBASE_PRIVATE_KEY = "test-key";
    process.env.ALLOWED_EMAILS = "dp.ceolpan@gmail.com";
  });

  it("returns 500 when Firebase Admin credentials are not configured", async () => {
    delete process.env.FIREBASE_PROJECT_ID;

    const res = await request(buildApp()).get("/protected").set("Authorization", "Bearer good");
    expect(res.status).toBe(500);
    expect(verifyIdToken).not.toHaveBeenCalled();
  });

  it("returns 401 when no Authorization header is present", async () => {
    const res = await request(buildApp()).get("/protected");
    expect(res.status).toBe(401);
  });

  it("returns 401 when the token fails verification", async () => {
    verifyIdToken.mockRejectedValue(new Error("bad token"));

    const res = await request(buildApp()).get("/protected").set("Authorization", "Bearer bad");
    expect(res.status).toBe(401);
  });

  it("returns 403 when the verified email is not allowlisted", async () => {
    verifyIdToken.mockResolvedValue({ uid: "uid-1", email: "someone-else@gmail.com" });

    const res = await request(buildApp()).get("/protected").set("Authorization", "Bearer good");
    expect(res.status).toBe(403);
  });

  it("allows the request through and attaches req.user for an allowlisted email", async () => {
    verifyIdToken.mockResolvedValue({ uid: "uid-1", email: "DP.Ceolpan@gmail.com" });

    const res = await request(buildApp()).get("/protected").set("Authorization", "Bearer good");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ user: { uid: "uid-1", email: "dp.ceolpan@gmail.com" } });
  });
});
