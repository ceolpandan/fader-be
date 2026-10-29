import { describe, expect, it } from "vitest";
import { STORE_SESSION_TTL_MS, StoreSessions } from "./store-sessions";

describe("StoreSessions", () => {
  const session = { headers: { cookie: "a=1" } };

  it("returns a session until a day has passed", () => {
    let now = 1_000;
    const sessions = new StoreSessions(() => now);
    const expiresAt = sessions.set("u1", "bandcamp", session);
    expect(expiresAt.getTime()).toBe(1_000 + STORE_SESSION_TTL_MS);
    now += STORE_SESSION_TTL_MS - 1;
    expect(sessions.get("u1", "bandcamp")).toBe(session);
    now += 1;
    expect(sessions.get("u1", "bandcamp")).toBeNull();
  });

  it("keeps sessions apart per collector", () => {
    const sessions = new StoreSessions();
    sessions.set("u1", "bandcamp", session);
    expect(sessions.get("u2", "bandcamp")).toBeNull();
  });

  it("forgets a session that was cleared", () => {
    const sessions = new StoreSessions();
    sessions.set("u1", "bandcamp", session);
    sessions.clear("u1", "bandcamp");
    expect(sessions.get("u1", "bandcamp")).toBeNull();
  });
});
