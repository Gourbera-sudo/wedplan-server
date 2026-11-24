import { ObjectId } from "mongodb";

import { collection } from "../config/db.js";
import { isServiceCategory, SERVICE_CATEGORIES } from "../config/categories.js";
import { ApiError } from "../middleware/error.js";
import { isPremiumActive } from "../lib/subscription.js";

const PUBLIC_FILTER = { isApproved: true, isActive: true };
const VENDOR_FIELDS = { vendorId: 1 };

function parseListQuery(query) {
  const search = String(query.search || "").trim();
  const category = String(query.category || "").trim();
  const location = String(query.location || "").trim();
  const sort = query.sort === "price_desc" ? "price_desc" : "price_asc";
  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(50, Math.max(1, Number(query.limit) || 12));
  return { search, category, location, sort, page, limit };
}

function buildFilter({ search, category, location }) {
  const filter = { ...PUBLIC_FILTER };
  if (search) {
    // Escape user input so it is matched literally, not as a regex.
    const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter.$or = [
      { name: new RegExp(escaped, "i") },
      { description: new RegExp(escaped, "i") },
      { vendorName: new RegExp(escaped, "i") },
      { vendorBusinessName: new RegExp(escaped, "i") },
    ];
  }
  if (isServiceCategory(category)) filter.category = category;
  if (location) {
    filter.location = new RegExp(
      location.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      "i",
    );
  }
  return filter;
}

/** GET /api/services — public browse: search, category, location, price sort. */
export async function listServices(req, res, next) {
  try {
    const query = parseListQuery(req.query);
    const filter = buildFilter(query);
    const sort = query.sort === "price_desc" ? { price: -1 } : { price: 1 };

    const db = collection("services");
    const [items, total] = await Promise.all([
      db
        .find(filter)
        .sort({ ...sort, createdAt: -1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .toArray(),
      db.countDocuments(filter),
    ]);

    res.json({
      services: items,
      total,
      page: query.page,
      pages: Math.ceil(total / query.limit) || 1,
      categories: SERVICE_CATEGORIES,
    });
  } catch (err) {
    next(err);
  }
}

/** GET /api/services/featured — the home page carousel (max 6, approved only). */
export async function featuredServices(_req, res, next) {
  try {
    const items = await collection("services")
      .find({ ...PUBLIC_FILTER, featured: true })
      .sort({ order: 1, createdAt: -1 })
      .limit(6)
      .toArray();
    res.json({ services: items });
  } catch (err) {
    next(err);
  }
}

/** GET /api/services/:id — public detail. Rejected/hidden services are 404. */
export async function getService(req, res, next) {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) throw new ApiError(404, "Service not found.");
    const service = await collection("services").findOne({ _id: new ObjectId(id) });
    if (!service) throw new ApiError(404, "Service not found.");
    const isOwner = req.user && String(service.vendorId) === String(req.user._id);
    const isAdmin = req.user?.role === "admin";
    if (!isOwner && !isAdmin && (!service.isApproved || !service.isActive)) {
      throw new ApiError(404, "Service not found.");
    }
    res.json({ service });
  } catch (err) {
    next(err);
  }
}

const SERVICE_BODY_FIELDS = [
  "name",
  "slug",
  "category",
  "description",
  "location",
  "price",
  "image",
  "images",
  "featured",
  "eventTypes",
  "availability",
  "isActive",
];

function pickServiceBody(body) {
  const out = {};
  for (const key of SERVICE_BODY_FIELDS) {
    if (body[key] !== undefined) out[key] = body[key];
  }
  return out;
}

function validateServiceBody(body, { partial = false } = {}) {
  const errors = [];
  const required = ["name", "category", "description", "location", "price"];
  if (!partial) {
    for (const key of required) {
      if (!String(body[key] ?? "").trim()) errors.push(`${key} is required.`);
    }
  }
  if (body.category !== undefined && !isServiceCategory(body.category)) {
    errors.push("category must be one of the six WedPlan categories.");
  }
  if (body.price !== undefined) {
    const price = Number(body.price);
    if (!Number.isFinite(price) || price < 0) errors.push("price must be a positive number.");
  }
  if (body.name !== undefined && !String(body.name).trim()) {
    errors.push("name cannot be empty.");
  }
  if (body.isActive !== undefined && typeof body.isActive !== "boolean") {
    errors.push("isActive must be a boolean.");
  }
  for (const key of ["eventTypes", "availability"]) {
    if (body[key] === undefined) continue;
    if (
      !Array.isArray(body[key]) ||
      body[key].length > 12 ||
      body[key].some((value) => typeof value !== "string" || value.length > 120)
    ) {
      errors.push(`${key} must be a list of up to 12 short strings.`);
    }
  }
  if (errors.length) throw new ApiError(400, errors.join(" "));
}

/** POST /api/services — vendor creates a listing (starts as pending). */
export async function createService(req, res, next) {
  try {
    validateServiceBody(req.body);
    const body = pickServiceBody(req.body);

    // Free plan cap: three active listings max. Expired premium is free again.
    if (!isPremiumActive(req.user)) {
      const active = await collection("services").countDocuments({
        vendorId: req.user._id,
        isActive: true,
      });
      if (active >= 3) {
        throw new ApiError(
          403,
          "Free plan allows up to 3 active services. Upgrade to premium for more.",
        );
      }
    }

    const now = new Date();
    const doc = {
      ...body,
      price: Number(body.price),
      vendorId: req.user._id,
      vendorName: req.user.name,
      vendorBusinessName: req.user.businessName || "",
      vendorVerified: isPremiumActive(req.user),
      isApproved: false, // every new listing waits for admin approval
      isActive: true,
      status: "pending",
      featured: false,
      order: 99,
      images: Array.isArray(body.images) ? body.images : [],
      createdAt: now,
      updatedAt: now,
    };

    const result = await collection("services").insertOne(doc);
    res.status(201).json({ service: { ...doc, _id: result.insertedId } });
  } catch (err) {
    next(err);
  }
}

/** Loads a service and asserts the caller owns it (admins pass). */
async function loadOwnedService(req) {
  const { id } = req.params;
  if (!ObjectId.isValid(id)) throw new ApiError(404, "Service not found.");
  const service = await collection("services").findOne({ _id: new ObjectId(id) });
  if (!service) throw new ApiError(404, "Service not found.");
  if (
    req.user.role !== "admin" &&
    String(service.vendorId) !== String(req.user._id)
  ) {
    throw new ApiError(403, "You can only manage your own services.");
  }
  return service;
}

const REVIEW_FIELDS = [
  "name",
  "category",
  "description",
  "location",
  "price",
  "image",
  "images",
];

/**
 * PUT /api/services/:id — owner (or admin) edits. Content changes go back to
 * pending review; toggling `isActive` alone keeps the existing approval.
 */
export async function updateService(req, res, next) {
  try {
    const current = await loadOwnedService(req);
    const { id } = req.params;
    validateServiceBody(req.body, { partial: true });

    const updates = pickServiceBody(req.body);
    delete updates.slug;
    if (updates.price !== undefined) updates.price = Number(updates.price);
    updates.updatedAt = new Date();

    const contentChanged = REVIEW_FIELDS.some(
      (key) =>
        key in updates &&
        JSON.stringify(updates[key]) !== JSON.stringify(current[key] ?? null),
    );
    if (contentChanged) {
      updates.isApproved = false;
      updates.status = "pending";
    }

    const result = await collection("services").findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: updates },
      { returnDocument: "after" },
    );
    if (!result) throw new ApiError(404, "Service not found.");
    res.json({ service: result });
  } catch (err) {
    next(err);
  }
}

/** DELETE /api/services/:id — owner (or admin) removes a listing. */
export async function deleteService(req, res, next) {
  try {
    await loadOwnedService(req);
    const { id } = req.params;
    const result = await collection("services").deleteOne({ _id: new ObjectId(id) });
    if (!result.deletedCount) throw new ApiError(404, "Service not found.");
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

/** GET /api/services/mine — the vendor's own listings (any approval state). */
export async function myServices(req, res, next) {
  try {
    const items = await collection("services")
      .find({ vendorId: req.user._id })
      .sort({ createdAt: -1 })
      .toArray();
    res.json({ services: items });
  } catch (err) {
    next(err);
  }
}

export { VENDOR_FIELDS };
