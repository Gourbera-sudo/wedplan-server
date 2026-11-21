import { createHmac, timingSafeEqual } from "node:crypto";

import { authenticate, optionalAuth, requireRole, signApiToken } from "../middleware/auth.js";
import { ApiError } from "../middleware/error.js";
import { env } from "../config/env.js";
import { getDatabase } from "../config/db.js";
import { collection } from "../config/db.js";
import { ObjectId } from "mongodb";

/**
 * Verifies a better-auth session cookie (`<token>.<HMAC-SHA256 base64>`,
 * URL-encoded) against BETTER_AUTH_SECRET and returns the raw token, or null.
 * Same scheme as better-auth's own bearer plugin.
 */
function verifySessionCookie(rawValue) {
  if (!env.betterAuthSecret) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(rawValue);
  } catch {
    return null;
  }
  const lastDot = decoded.lastIndexOf(".");
  if (lastDot <= 0) return null;
  const token = decoded.slice(0, lastDot);
  const signature = decoded.slice(lastDot + 1);
  const expected = createHmac("sha256", env.betterAuthSecret)
    .update(token)
    .digest("base64");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  return timingSafeEqual(a, b) ? token : null;
}

/**
 * Better Auth owns sign-in on the client (cookies), so this server never sees
 * passwords. It only exchanges a verified session for the bearer token the API
 * expects: the client posts the session cookie, we confirm it against the same
 * shared JWT secret Better Auth uses, and mint an API token.
 */
export async function createToken(req, res, next) {
  try {
    // The client forwards whatever session cookie it has; verify it the same
    // way better-auth does (its JWT plugin signs with BETTER_AUTH_SECRET).
    const cookieHeader = req.headers.cookie || "";
    const cookies = Object.fromEntries(
      cookieHeader
        .split(";")
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
          const i = part.indexOf("=");
          return [part.slice(0, i), decodeURIComponent(part.slice(i + 1))];
        }),
    );

    const sessionToken = cookies["better-auth.session_token"];
    if (!sessionToken) throw new ApiError(401, "No active session.");

    // better-auth signs cookies as `<token>.<base64 HMAC-SHA256>` using
    // BETTER_AUTH_SECRET — verify before trusting the token (same scheme as
    // better-auth's own bearer plugin).
    const token = verifySessionCookie(sessionToken);
    if (!token) throw new ApiError(401, "Invalid session cookie.");

    const db = getDatabase();
    const session = await db.collection("session").findOne({ token });
    if (!session) throw new ApiError(401, "Session not found or expired.");
    if (session.expiresAt && new Date(session.expiresAt) < new Date()) {
      throw new ApiError(401, "Session expired. Please sign in again.");
    }

    const user = await db
      .collection("user")
      .findOne({ _id: new ObjectId(session.userId) });
    if (!user) throw new ApiError(401, "Account no longer exists.");
    if (user.isBlocked || user.banned) {
      throw new ApiError(403, "This account has been blocked by an administrator.");
    }

    res.json({ token: signApiToken(user), role: user.role || "customer" });
  } catch (err) {
    next(err);
  }
}

/** GET /api/auth/me — the caller's live profile (role, plan, blocking). */
export async function me(req, res, next) {
  try {
    const user = await collection("user").findOne(
      { _id: req.user._id },
      {
        projection: {
          password: 0,
          emailVerified: 0,
          createdAt: 0,
          updatedAt: 0,
        },
      },
    );
    if (!user) throw new ApiError(401, "Account no longer exists.");
    res.json({ user });
  } catch (err) {
    next(err);
  }
}

export { authenticate, requireRole };
