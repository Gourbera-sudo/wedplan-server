import { ObjectId } from "mongodb";

import { isServiceCategory } from "../config/categories.js";
import { collection } from "../config/db.js";
import { ApiError } from "../middleware/error.js";

function regexTerm(value) {
  const escaped = String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(escaped, "i");
}

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

/** GET /api/admin/users — list accounts with optional server-side filters. */
export async function listUsers(req, res, next) {
  try {
    const search = String(req.query.search || "").trim();
    const role = String(req.query.role || "").trim();
    const filter = {};

    if (["customer", "vendor", "admin"].includes(role)) filter.role = role;
    if (search) {
      filter.$or = [
        { name: regexTerm(search) },
        { email: regexTerm(search) },
        { businessName: regexTerm(search) },
      ];
    }

    const users = await collection("user")
      .find(filter, { projection: { password: 0 } })
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
    // Subscription plan is deliberately ignored: premium must only come from a
    // verified payment (Stripe webhook or admin-verified UPI), never an admin
    // user-edit shortcut.
    const { role, isBlocked, businessName } = req.body || {};

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

    if (businessName !== undefined) {
      const name = String(businessName).trim();
      if (name.length > 120) throw new ApiError(400, "Business name is too long.");
      updates.businessName = name;
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
export async function listAllServices(req, res, next) {
  try {
    const search = String(req.query.search || "").trim();
    const category = String(req.query.category || "").trim();
    const status = String(req.query.status || "").trim();
    const active = String(req.query.isActive || "").trim();
    const filter = {};

    if (isServiceCategory(category)) filter.category = category;
    if (["pending", "approved", "rejected"].includes(status)) filter.status = status;
    if (active === "true" || active === "false") filter.isActive = active === "true";
    if (search) {
      filter.$or = [
        { name: regexTerm(search) },
        { description: regexTerm(search) },
        { location: regexTerm(search) },
        { vendorName: regexTerm(search) },
      ];
    }

    const services = await collection("services")
      .find(filter)
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
export async function listTransactions(req, res, next) {
  try {
    const search = String(req.query.search || "").trim().toLowerCase();
    const rows = await collection("transactions")
      .find({})
      .sort({ createdAt: -1 })
      .toArray();

    const ids = [
      ...new Set(rows.map((tx) => String(tx.vendorId || tx.userId || ""))),
    ]
      .filter((id) => ObjectId.isValid(id))
      .map((id) => new ObjectId(id));
    const vendors = ids.length
      ? await collection("user")
          .find(
            { _id: { $in: ids } },
            { projection: { name: 1, email: 1, image: 1 } },
          )
          .toArray()
      : [];
    const byId = new Map(vendors.map((vendor) => [String(vendor._id), vendor]));

    const transactions = rows
      .map((tx) => {
        const ownerId = String(tx.vendorId || tx.userId || "");
        const vendor = byId.get(ownerId) ?? null;
        return {
          ...tx,
          vendorId: tx.vendorId || tx.userId,
          vendor: vendor
            ? { name: vendor.name, email: vendor.email, image: vendor.image || "" }
            : null,
          vendorName: vendor?.name ?? "",
          vendorEmail: vendor?.email ?? "",
        };
      })
      .filter((tx) => {
        if (!search) return true;
        return [tx.vendorName, tx.vendorEmail, tx.ref, tx.plan, tx.status, tx.stripeSessionId]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(search));
      });

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
