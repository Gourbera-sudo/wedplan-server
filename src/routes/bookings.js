import { ObjectId } from "mongodb";

import { collection } from "../config/db.js";
import { ApiError } from "../middleware/error.js";

function isValidId(id) {
  return ObjectId.isValid(id);
}

/**
 * POST /api/bookings — customer requests a booking.
 * Rules enforced here: no self-booking, no duplicate for the same service +
 * event date, service must be public, and the request starts as `pending`.
 */
export async function createBooking(req, res, next) {
  try {
    if (req.user.role === "admin") {
      throw new ApiError(403, "Admin accounts cannot submit customer booking requests.");
    }

    const { serviceId, eventDate, eventLocation, guests, message } = req.body || {};
    if (!isValidId(serviceId)) throw new ApiError(400, "Invalid service.");
    if (!eventDate) throw new ApiError(400, "Event date is required.");
    const eventDateValue = new Date(eventDate);
    if (!Number.isFinite(eventDateValue.getTime())) {
      throw new ApiError(400, "Enter a valid event date.");
    }
    if (eventDateValue < new Date(new Date().toDateString())) {
      throw new ApiError(400, "Event date cannot be in the past.");
    }

    const service = await collection("services").findOne({
      _id: new ObjectId(serviceId),
    });
    if (!service || !service.isApproved || !service.isActive) {
      throw new ApiError(404, "Service not found.");
    }

    // Vendors cannot book their own services.
    if (String(service.vendorId) === String(req.user._id)) {
      throw new ApiError(400, "You cannot book your own service.");
    }

    // One active request per customer per service per event date. Cancelled
    // and rejected requests are closed, so a fresh request is allowed.
    const duplicate = await collection("bookings").findOne({
      serviceId: service._id,
      customerId: req.user._id,
      eventDate: eventDateValue,
      status: { $in: ["pending", "accepted"] },
    });
    if (duplicate) {
      throw new ApiError(409, "You already requested this service for that date.");
    }

    const now = new Date();
    const doc = {
      serviceId: service._id,
      serviceName: service.name,
      serviceImage: service.image || "",
      serviceCategory: service.category,
      vendorId: service.vendorId,
      vendorName: service.vendorName,
      customerId: req.user._id,
      customerName: req.user.name,
      customerEmail: req.user.email,
      eventDate: eventDateValue,
      eventLocation: String(eventLocation || service.location || ""),
      guests: Number(guests) || 0,
      message: String(message || ""),
      status: "pending", // waits for the vendor to accept/reject
      createdAt: now,
      updatedAt: now,
    };

    const result = await collection("bookings").insertOne(doc);
    res.status(201).json({ booking: { ...doc, _id: result.insertedId } });
  } catch (err) {
    // The partial unique index is the final guard against concurrent requests.
    if (err?.code === 11000) {
      next(new ApiError(409, "You already requested this service for that date."));
      return;
    }
    next(err);
  }
}

/** GET /api/bookings/mine — customer's own bookings (newest first). */
export async function myBookings(req, res, next) {
  try {
    const items = await collection("bookings")
      .find({ customerId: req.user._id })
      .sort({ createdAt: -1 })
      .toArray();
    res.json({ bookings: items });
  } catch (err) {
    next(err);
  }
}

/** GET /api/bookings/requests — vendor's incoming booking requests. */
export async function bookingRequests(req, res, next) {
  try {
    const items = await collection("bookings")
      .find({ vendorId: req.user._id })
      .sort({ createdAt: -1 })
      .toArray();
    res.json({ bookings: items });
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/bookings/:id — status transitions.
 * Vendor: pending → accepted|rejected. Customer: pending → cancelled.
 * Anything else from a non-pending booking is 409.
 */
export async function decideBooking(req, res, next) {
  try {
    const { id } = req.params;
    const { status } = req.body || {};
    if (!isValidId(id)) throw new ApiError(404, "Booking not found.");
    if (!["accepted", "rejected", "cancelled"].includes(status)) {
      throw new ApiError(400, "Invalid status.");
    }

    const booking = await collection("bookings").findOne({ _id: new ObjectId(id) });
    if (!booking) throw new ApiError(404, "Booking not found.");

    const isVendor = String(booking.vendorId) === String(req.user._id);
    const isCustomer = String(booking.customerId) === String(req.user._id);

    // Check authorization before status so a vendor cannot probe another
    // vendor's booking IDs and learn their state from a 409 response.
    if (status === "cancelled" && !isCustomer) {
      throw new ApiError(403, "Only the customer can cancel a booking.");
    }
    if ((status === "accepted" || status === "rejected") && !isVendor) {
      throw new ApiError(403, "Only the vendor can accept or reject a request.");
    }

    // Only pending requests can be decided or cancelled.
    if (booking.status !== "pending") {
      throw new ApiError(
        409,
        `This booking is already ${booking.status} and can no longer be changed.`,
      );
    }

    const result = await collection("bookings").findOneAndUpdate(
      { _id: new ObjectId(id), status: "pending" },
      { $set: { status, updatedAt: new Date() } },
      { returnDocument: "after" },
    );
    if (!result) throw new ApiError(409, "This booking is no longer pending.");

    res.json({ booking: result });
  } catch (err) {
    next(err);
  }
}
