import { ObjectId } from "mongodb";

import { collection } from "../config/db.js";
import { ApiError } from "../middleware/error.js";

/** GET /api/admin/users/:id — full account detail (passwords never returned). */
export async function getUser(req, res, next) {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) throw new ApiError(404, "User not found.");
    const user = await collection("user").findOne(
      { _id: new ObjectId(id) },
      { projection: { password: 0 } },
    );
    if (!user) throw new ApiError(404, "User not found.");
    res.json({ user });
  } catch (err) {
    next(err);
  }
}

/** GET /api/admin/users — list every account (admin only). */
export async function listUsers(_req, res, next) {
  try {
    const users = await collection("user")
      .find({}, { projection: { password: 0 } })
      .sort({ createdAt: -1 })
      .toArray();
    res.json({ users });
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/admin/users/:id — block/unblock or change a role.
 * Guards: admins cannot demote or block themselves, and no route here can
 * promote an account to admin (the only way to become admin is ADMIN_EMAILS
 * at sign-up, which is env-only).
 */
export async function updateUser(req, res, next) {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) throw new ApiError(404, "User not found.");
    const targetId = new ObjectId(id);
    const self = String(req.user._id) === String(targetId);

    const updates = {};
    const { role, isBlocked, businessName, subscriptionPlan } = req.body || {};

    if (role !== undefined) {
      if (!["customer", "vendor", "admin"].includes(role)) {
        throw new ApiError(400, "Invalid role.");
      }
      if (role === "admin") {
        throw new ApiError(403, "Admin role cannot be assigned through the API.");
      }
      if (self) throw new ApiError(400, "You cannot change your own role.");
      updates.role = role;
    }

    if (isBlocked !== undefined) {
      if (typeof isBlocked !== "boolean") {
        throw new ApiError(400, "isBlocked must be a boolean.");
      }
      if (self && isBlocked) throw new ApiError(400, "You cannot block yourself.");
      updates.isBlocked = isBlocked;
      updates.banned = isBlocked; // better-auth's own flag, kept in sync
    }

    if (businessName !== undefined) updates.businessName = String(businessName);
    if (subscriptionPlan !== undefined) {
      if (!["free", "premium"].includes(subscriptionPlan)) {
        throw new ApiError(400, "Invalid subscription plan.");
      }
      updates.subscriptionPlan = subscriptionPlan;
    }

    if (Object.keys(updates).length === 0) {
      throw new ApiError(400, "Nothing to update.");
    }
    updates.updatedAt = new Date();

    const user = await collection("user").findOneAndUpdate(
      { _id: targetId },
      { $set: updates },
      { returnDocument: "after", projection: { password: 0 } },
    );
    if (!user) throw new ApiError(404, "User not found.");
    res.json({ user });
  } catch (err) {
    next(err);
  }
}

/** GET /api/admin/services — every listing, including unapproved ones. */
export async function listAllServices(_req, res, next) {
  try {
    const services = await collection("services")
      .find({})
      .sort({ createdAt: -1 })
      .toArray();
    res.json({ services });
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/admin/services/:id — approve or reject a listing.
 * Rejected listings are hidden from every public query (isApproved: false).
 */
export async function moderateService(req, res, next) {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) throw new ApiError(404, "Service not found.");
    const { action } = req.body || {};
    if (!["approve", "reject"].includes(action)) {
      throw new ApiError(400, "action must be approve or reject.");
    }

    const service = await collection("services").findOneAndUpdate(
      { _id: new ObjectId(id) },
      {
        $set: {
          isApproved: action === "approve",
          status: action === "approve" ? "approved" : "rejected",
          updatedAt: new Date(),
        },
      },
      { returnDocument: "after" },
    );
    if (!service) throw new ApiError(404, "Service not found.");
    res.json({ service });
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/admin/services/:id/status — pause or reactivate a listing without
 * changing its approval. Hidden/pending listings stay hidden from customers.
 */
export async function setServiceStatus(req, res, next) {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) throw new ApiError(404, "Service not found.");
    const { isActive } = req.body || {};
    if (typeof isActive !== "boolean") {
      throw new ApiError(400, "isActive must be a boolean.");
    }

    const service = await collection("services").findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: { isActive, updatedAt: new Date() } },
      { returnDocument: "after" },
    );
    if (!service) throw new ApiError(404, "Service not found.");
    res.json({ service });
  } catch (err) {
    next(err);
  }
}

/** DELETE /api/admin/services/:id — remove an inappropriate listing. */
export async function deleteService(req, res, next) {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) throw new ApiError(404, "Service not found.");
    const result = await collection("services").deleteOne({ _id: new ObjectId(id) });
    if (!result.deletedCount) throw new ApiError(404, "Service not found.");
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/admin/transactions — full ledger. Stripe rows are written by the
 * verified webhook; UPI rows are verified through the admin-only PATCH route
 * in payments.js (never from a client redirect).
 */
export async function listTransactions(_req, res, next) {
  try {
    const transactions = await collection("transactions")
      .find({})
      .sort({ createdAt: -1 })
      .toArray();
    res.json({ transactions });
  } catch (err) {
    next(err);
  }
}

/** GET /api/admin/stats — dashboard counters. */
export async function adminStats(_req, res, next) {
  try {
    const db = collection;
    const [
      users,
      vendors,
      customers,
      services,
      pendingServices,
      bookings,
      transactions,
    ] = await Promise.all([
      db("user").countDocuments(),
      db("user").countDocuments({ role: "vendor" }),
      db("user").countDocuments({ role: "customer" }),
      db("services").countDocuments(),
      db("services").countDocuments({ status: "pending", isActive: true }),
      db("bookings").countDocuments(),
      db("transactions").countDocuments({ status: "succeeded" }),
    ]);
    res.json({
      users,
      vendors,
      customers,
      services,
      pendingServices,
      bookings,
      transactions,
    });
  } catch (err) {
    next(err);
  }
}
