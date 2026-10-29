import type { DigitalStoreId, StoreSession } from "./types";

/** How long a pasted curl is kept: its short-lived cookies (Stripe's session id, say) are stale by the next day. */
export const STORE_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The curls collectors pasted, kept in memory only, per collector and store. They expire after a
 * day and a restart forgets them: the collector pastes a fresh one before the next check.
 */
export class StoreSessions {
  private readonly sessions = new Map<string, { session: StoreSession; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  set(uid: string, store: DigitalStoreId, session: StoreSession): Date {
    const expiresAt = this.now() + STORE_SESSION_TTL_MS;
    this.sessions.set(key(uid, store), { session, expiresAt });
    return new Date(expiresAt);
  }

  /** The collector's session, or null when none was pasted or it has expired. */
  get(uid: string, store: DigitalStoreId): StoreSession | null {
    const entry = this.sessions.get(key(uid, store));
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.sessions.delete(key(uid, store));
      return null;
    }
    return entry.session;
  }

  /** Forgets a session the store refused. */
  clear(uid: string, store: DigitalStoreId): void {
    this.sessions.delete(key(uid, store));
  }
}

function key(uid: string, store: DigitalStoreId): string {
  return `${uid}:${store}`;
}
