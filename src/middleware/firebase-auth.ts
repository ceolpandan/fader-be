import type { NextFunction, Request, Response } from "express";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { logger } from "../util/logger";

function firebaseAuthClient() {
  if (getApps().length === 0) {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
    if (!projectId || !clientEmail || !privateKey) {
      throw new Error(
        "Missing FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY environment variables",
      );
    }
    initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
  }
  return getAuth();
}

function allowedEmails(): string[] {
  return (process.env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email.length > 0);
}

function bearerToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
}

export async function firebaseAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = bearerToken(req);
  if (!token) {
    res.status(401).json({ error: "Missing bearer token" });
    return;
  }

  let client: ReturnType<typeof getAuth>;
  try {
    client = firebaseAuthClient();
  } catch (err) {
    logger.error("Firebase Admin SDK is not configured", err);
    res.status(500).json({ error: "Internal server error" });
    return;
  }

  let email: string | undefined;
  let uid: string;
  try {
    const decoded = await client.verifyIdToken(token);
    uid = decoded.uid;
    email = decoded.email?.toLowerCase();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
    return;
  }

  if (!email || !allowedEmails().includes(email)) {
    res.status(403).json({ error: "Not authorized" });
    return;
  }

  req.user = { uid, email };
  next();
}
