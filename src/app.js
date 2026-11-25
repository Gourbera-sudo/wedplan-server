import express from "express";

import { env } from "./config/env.js";
import { errorHandler, notFound } from "./middleware/error.js";
import { authenticate, optionalAuth, requireRole } from "./middleware/auth.js";
import {
  createToken,
  me,
} from "./routes/auth.js";
import {
  listServices,
  featuredServices,
  getService,
  createService,
  updateService,
  deleteService,
  myServices,
} from "./routes/services.js";
import {
  createBooking,
  myBookings,
  bookingRequests,
  decideBooking,
} from "./routes/bookings.js";
import {
  getUser,
  listUsers,
  updateUser,
  listAllServices,
  moderateService,
  setServiceStatus,
  deleteService as deleteAdminService,
  listTransactions,
  adminStats,
} from "./routes/admin.js";
import {
  createCheckout,
  stripeWebhook,
  paymentStatus,
  createUpiOrder,
  submitUpiUtr,
  upiStatus,
  verifyUpiPayment,
} from "./routes/payments.js";
import { updateProfile, uploadImage } from "./routes/profile.js";

export function createApp() {
  const app = express();

  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", env.clientUrl);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization",
    );
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  // Stripe needs the RAW body to verify its signature — mount before json().
  app.post(
    "/api/payments/webhook",
    express.raw({ type: "application/json" }),
    stripeWebhook,
  );

  app.use(express.json({ limit: "2mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, service: "wedplan-server" });
  });

  // --- Auth (session cookie → API JWT) ---
  app.post("/api/auth/token", createToken);
  app.get("/api/auth/me", authenticate, me);

  // --- Public services ---
  app.get("/api/services", listServices);
  app.get("/api/services/featured", featuredServices);
  app.get("/api/services/:id", optionalAuth, getService);

  // --- Vendor services (role-gated) ---
  app.get(
    "/api/vendor/services",
    authenticate,
    requireRole("vendor", "admin"),
    myServices,
  );
  app.post(
    "/api/vendor/services",
    authenticate,
    requireRole("vendor", "admin"),
    createService,
  );
  app.put(
    "/api/vendor/services/:id",
    authenticate,
    requireRole("vendor", "admin"),
    updateService,
  );
  app.delete(
    "/api/vendor/services/:id",
    authenticate,
    requireRole("vendor", "admin"),
    deleteService,
  );

  // --- Bookings ---
  // Any authenticated user may request a booking; the route itself rejects
  // self-booking (400) and duplicates (409). /mine filters to the caller.
  app.post("/api/bookings", authenticate, createBooking);
  app.get("/api/bookings/mine", authenticate, myBookings);
  app.get(
    "/api/bookings/requests",
    authenticate,
    requireRole("vendor"),
    bookingRequests,
  );
  app.patch("/api/bookings/:id", authenticate, decideBooking);

  // --- Profile ---
  app.patch("/api/profile", authenticate, updateProfile);
  app.post("/api/profile/image", authenticate, uploadImage);

  // --- Payments ---
  app.post(
    "/api/payments/checkout",
    authenticate,
    requireRole("vendor"),
    createCheckout,
  );
  app.get("/api/payments/status", authenticate, paymentStatus);
  // UPI: vendor starts the payment and submits the UTR; admin verifies it.
  app.post(
    "/api/payments/upi/create",
    authenticate,
    requireRole("vendor"),
    createUpiOrder,
  );
  app.post(
    "/api/payments/upi/submit",
    authenticate,
    requireRole("vendor"),
    submitUpiUtr,
  );
  app.get("/api/payments/upi/status", authenticate, upiStatus);

  // --- Admin only ---
  app.get("/api/admin/stats", authenticate, requireRole("admin"), adminStats);
  app.get("/api/admin/users", authenticate, requireRole("admin"), listUsers);
  app.get(
    "/api/admin/users/:id",
    authenticate,
    requireRole("admin"),
    getUser,
  );
  app.patch(
    "/api/admin/users/:id",
    authenticate,
    requireRole("admin"),
    updateUser,
  );
  app.get(
    "/api/admin/services",
    authenticate,
    requireRole("admin"),
    listAllServices,
  );
  app.patch(
    "/api/admin/services/:id",
    authenticate,
    requireRole("admin"),
    moderateService,
  );
  app.patch(
    "/api/admin/services/:id/status",
    authenticate,
    requireRole("admin"),
    setServiceStatus,
  );
  app.delete(
    "/api/admin/services/:id",
    authenticate,
    requireRole("admin"),
    deleteAdminService,
  );
  app.get(
    "/api/admin/transactions",
    authenticate,
    requireRole("admin"),
    listTransactions,
  );
  app.patch(
    "/api/admin/transactions/:ref/verify",
    authenticate,
    requireRole("admin"),
    verifyUpiPayment,
  );

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
