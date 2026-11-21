import jwt from "jsonwebtoken";

import { env } from "../config/env.js";
import { ApiError } from "./error.js";

/**
 * Signs a short-lived API token for a Better Auth user. The client calls this
 * through `POST /api/auth/token` (session cookie) and sends the result as
 * `Authorization: Bearer <token>` on every wedplan-server request.
 */
export function signApiToken(user) {
  return jwt.sign(
    {
      sub: String(user._id),
      role: user.role || "customer",
      email: user.email,
      name: user.name,
    },
    env.jwtSecret,
    { expiresIn: env.jwtExpiresIn },
  );
}

/**
 * Verifies the bearer token and loads the live user document, so role changes
 * and blocks take effect immediately instead of waiting for the token to expire.
 */
async function authenticate(req, _res, next) {
  try {
    const header = req.headers.authorization || "";
    const [scheme, token] = header.split(" ");
    if (scheme !== "Bearer" || !token) {
      throw new ApiError(401, "Authentication required.");
    }

    let payload;
    try {
      payload = jwt.verify(token, env.jwtSecret);
    } catch {
      throw new ApiError(401, "Session expired. Please sign in again.");
    }

    const { ObjectId } = await import("mongodb");
    if (!ObjectId.isValid(payload.sub)) {
      throw new ApiError(401, "Invalid session.");
    }

    const { collection } = await import("../config/db.js");
    const user = await collection("user").findOne({ _id: new ObjectId(payload.sub) });
    if (!user) throw new ApiError(401, "Account no longer exists.");

    // Blocked users are locked out of every protected endpoint, whatever their role.
    if (user.isBlocked || user.banned) {
      throw new ApiError(403, "This account has been blocked by an administrator.");
    }

    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

/** Role gate: 403 unless the caller holds one of the allowed roles. */
export function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) return next(new ApiError(401, "Authentication required."));
    if (!roles.includes(req.user.role)) {
      return next(new ApiError(403, "You do not have permission to do that."));
    }
    next();
  };
}

/**
 * Ownership gate for resources keyed by a user id. Pass the field that stores
 * the owner (`vendorId`, `customerId`, `userId`); admins always pass.
 */
export function requireOwner(field) {
  return (req, _res, next) => {
    if (!req.user) return next(new ApiError(401, "Authentication required."));
    const ownerId = req.resource?.[field];
    if (!ownerId) return next(new ApiError(404, "Not found."));
    if (req.user.role !== "admin" && String(ownerId) !== String(req.user._id)) {
      return next(new ApiError(403, "You can only manage your own resources."));
    }
    next();
  };
}

export { authenticate };

/**
 * Populates req.user when a valid token is present, but never rejects —
 * used by public reads that behave differently for signed-in owners.
 */
export async function optionalAuth(req, _res, next) {
  try {
    await authenticate(req, _res, () => {});
    next();
  } catch {
    next();
  }
}
