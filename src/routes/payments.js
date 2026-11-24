import { randomBytes } from "node:crypto";

import Stripe from "stripe";
import { ObjectId } from "mongodb";

import { env } from "../config/env.js";
import { collection } from "../config/db.js";
import { ApiError } from "../middleware/error.js";
import { effectivePlan, isPremiumActive } from "../lib/subscription.js";

let stripeClient;
function stripe() {
  if (!env.stripeSecretKey) {
    throw new ApiError(
      503,
      "Payments are not configured yet (STRIPE_SECRET_KEY missing in .env).",
    );
  }
  if (!stripeClient) stripeClient = new Stripe(env.stripeSecretKey);
  return stripeClient;
}

const PREMIUM_DAYS = 30;

/**
 * Shared activation step. Only trusted callers (the verified Stripe webhook or
 * an admin verifying a UPI payment) may invoke it — never a success redirect.
 */
export async function activatePremium(userId) {
  if (!ObjectId.isValid(userId)) return false;

  const expires = new Date();
  expires.setDate(expires.getDate() + PREMIUM_DAYS);

  await collection("user").updateOne(
    { _id: new ObjectId(userId) },
    {
      $set: {
        subscriptionPlan: "premium",
        subscriptionExpiresAt: expires,
        updatedAt: new Date(),
      },
    },
  );

  // Premium vendors get the verified badge on their listings.
  await collection("services").updateMany(
    { vendorId: new ObjectId(userId) },
    { $set: { vendorVerified: true, updatedAt: new Date() } },
  );
  return true;
}

function upiConfig() {
  if (!env.upiVpa) {
    throw new ApiError(
      503,
      "UPI payments are not configured yet (UPI_VPA missing in the server .env).",
    );
  }
  const amountPaise = Number(env.upiMonthlyPaise);
  if (!Number.isInteger(amountPaise) || amountPaise < 100) {
    throw new ApiError(500, "UPI_MONTHLY_PAISE must be at least 100 paise.");
  }
  return {
    vpa: env.upiVpa,
    payeeName: env.upiPayeeName || "WedPlan",
    amountPaise,
  };
}

function newUpiRef() {
  return `WP${Date.now().toString(36).toUpperCase()}${randomBytes(4).toString("hex").toUpperCase()}`;
}

/**
 * POST /api/payments/checkout — creates a Stripe Checkout session for the
 * premium plan. The session id is stored so the webhook can match it later;
 * nothing about the subscription is trusted from the client.
 */
export async function createCheckout(req, res, next) {
  try {
    if (isPremiumActive(req.user)) {
      throw new ApiError(400, "You are already on the premium plan.");
    }

    const session = await stripe().checkout.sessions.create({
      mode: "payment",
      customer_email: req.user.email,
      line_items: [
        {
          // Fixed premium price: $49 one-time (10000 cents).
          price_data: {
            currency: "usd",
            unit_amount: 4900,
            product_data: {
              name: "WedPlan Premium",
              description: "Unlimited service listings + verified vendor badge",
            },
          },
          quantity: 1,
        },
      ],
      metadata: {
        userId: String(req.user._id),
        plan: "premium",
      },
      success_url: `${env.clientUrl}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${env.clientUrl}/payment/cancel`,
    });

    await collection("transactions").updateOne(
      { stripeSessionId: session.id },
      {
        $set: {
          stripeSessionId: session.id,
          userId: req.user._id,
          amount: 4900,
          currency: "usd",
          status: "pending",
          plan: "premium",
          createdAt: new Date(),
        },
      },
      { upsert: true },
    );

    res.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/payments/webhook — Stripe's signed callback. The raw body is
 * required for signature verification, so this route is mounted before the
 * JSON parser (see app.js). Premium is activated ONLY from a verified
 * `checkout.session.completed` event — never from the client redirect.
 *
 * NOTE: uses the raw-body string; express.raw() is mounted for this path.
 */
export async function stripeWebhook(req, res, next) {
  try {
    if (!env.stripeWebhookSecret) {
      throw new ApiError(
        503,
        "Webhook secret not configured (STRIPE_WEBHOOK_SECRET missing in .env).",
      );
    }

    let event;
    try {
      event = stripe().constructEvent(
        req.body, // Buffer from express.raw()
        req.headers["stripe-signature"],
        env.stripeWebhookSecret,
      );
    } catch (err) {
      return res.status(400).json({ error: `Webhook signature verification failed: ${err.message}` });
    }

    const paidEvents = [
      "checkout.session.completed",
      "checkout.session.async_payment_succeeded",
    ];

    if (paidEvents.includes(event.type) || event.type === "checkout.session.async_payment_failed") {
      const session = event.data.object;
      const paid = event.type !== "checkout.session.async_payment_failed" &&
        session.payment_status === "paid";
      const status = event.type === "checkout.session.async_payment_failed"
        ? "failed"
        : paid
          ? "succeeded"
          : "pending";

      const tx = await collection("transactions").findOne({
        stripeSessionId: session.id,
      });

      if (tx) {
        await collection("transactions").updateOne(
          { _id: tx._id },
          {
            $set: {
              status,
              stripePaymentIntent: session.payment_intent || null,
              paidAt: paid ? new Date() : null,
            },
          },
        );

        // Activate premium only after Stripe confirms the money arrived, and
        // only for the vendor recorded on the transaction at checkout.
        if (paid && String(tx.userId) === String(session.metadata?.userId)) {
          await activatePremium(tx.userId);
        }
      }
    }

    res.json({ received: true });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/payments/status?session_id=... — lets the success page confirm the
 * payment with Stripe directly (the webhook is still the source of truth).
 */
export async function paymentStatus(req, res, next) {
  try {
    const { session_id } = req.query;
    if (!session_id) throw new ApiError(400, "session_id is required.");

    const session = await stripe().checkout.sessions.retrieve(session_id);
    if (session.metadata?.userId !== String(req.user._id)) {
      throw new ApiError(403, "This payment belongs to another account.");
    }

    const tx = await collection("transactions").findOne({
      stripeSessionId: session_id,
    });

    // Re-read the user: the webhook (not this request) is what flips the plan.
    const user = await collection("user").findOne({ _id: req.user._id });

    res.json({
      status: session.status,
      paymentStatus: session.payment_status,
      plan: session.metadata?.plan,
      effectivePlan: effectivePlan(user),
      // The page should trust this flag, which only the webhook can set true.
      activated: isPremiumActive(user),
      subscriptionExpiresAt: user?.subscriptionExpiresAt ?? null,
      transaction: tx || null,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/payments/upi/create — starts a UPI subscription payment.
 *
 * UPI has no gateway webhook in this setup: the server creates a pending
 * transaction and a UPI deep link/QR payload. Premium is activated only after
 * the vendor submits a UTR and an admin verifies the payment.
 */
export async function createUpiOrder(req, res, next) {
  try {
    if (req.user.role !== "vendor") {
      throw new ApiError(403, "Only vendors can purchase a subscription.");
    }
    if (isPremiumActive(req.user)) {
      throw new ApiError(400, "You are already on the premium plan.");
    }

    const { vpa, payeeName, amountPaise } = upiConfig();

    // Reuse a still-open order so a double click (or refresh) cannot create
    // several pending payments for the same vendor.
    const existing = await collection("transactions").findOne({
      userId: req.user._id,
      method: "upi",
      status: { $in: ["awaiting_upi", "verifying"] },
    });
    if (existing) {
      return res.json({
        ref: existing.ref,
        amountPaise: existing.amount,
        amount: existing.amount / 100,
        currency: "INR",
        vpa: existing.upiVpa,
        payeeName,
        upiUri: existing.upiUri,
        status: existing.status,
        utr: existing.utr ?? null,
      });
    }

    const ref = newUpiRef();
    const amount = (amountPaise / 100).toFixed(2);
    const note = `WedPlan Premium (${ref})`;
    const upiUri =
      `upi://pay?pa=${encodeURIComponent(vpa)}` +
      `&pn=${encodeURIComponent(payeeName)}` +
      `&am=${amount}&cu=INR` +
      `&tn=${encodeURIComponent(note)}` +
      `&tr=${encodeURIComponent(ref)}`;

    await collection("transactions").insertOne({
      ref,
      userId: req.user._id,
      amount: amountPaise,
      currency: "inr",
      status: "awaiting_upi",
      plan: "premium",
      method: "upi",
      upiVpa: vpa,
      upiUri,
      utr: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    res.status(201).json({
      ref,
      amountPaise,
      amount: Number(amount),
      currency: "INR",
      vpa,
      payeeName,
      upiUri,
      status: "awaiting_upi",
      utr: null,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/payments/upi/submit — records the UTR copied from the UPI app.
 * This only moves the transaction to `verifying`; it never changes the plan.
 */
export async function submitUpiUtr(req, res, next) {
  try {
    const { ref, utr } = req.body || {};
    if (typeof ref !== "string" || !/^WP[0-9A-Z]{10,}$/.test(ref)) {
      throw new ApiError(400, "A valid payment reference is required.");
    }
    const normalizedUtr = String(utr ?? "")
      .trim()
      .toUpperCase()
      .replace(/\s+/g, "");
    if (!/^[A-Z0-9]{8,24}$/.test(normalizedUtr)) {
      throw new ApiError(400, "Enter the 8–24 character UPI transaction ID.");
    }

    const tx = await collection("transactions").findOne({
      ref,
      userId: req.user._id,
      method: "upi",
    });
    if (!tx) throw new ApiError(404, "Payment request not found.");
    if (tx.status === "succeeded") {
      return res.json({ ok: true, status: tx.status, message: "Already verified." });
    }
    if (!["awaiting_upi", "verifying"].includes(tx.status)) {
      throw new ApiError(400, "This payment request is no longer active.");
    }

    await collection("transactions").updateOne(
      { _id: tx._id },
      {
        $set: {
          status: "verifying",
          utr: normalizedUtr,
          submittedAt: new Date(),
          updatedAt: new Date(),
        },
      },
    );

    res.json({
      ok: true,
      status: "verifying",
      message:
        "Payment submitted. Premium activates once our team verifies the UPI transaction.",
    });
  } catch (err) {
    next(err);
  }
}

/** GET /api/payments/upi/status?ref=... — safe polling for the success page. */
export async function upiStatus(req, res, next) {
  try {
    const ref = String(req.query.ref ?? "");
    if (!/^WP[0-9A-Z]{10,}$/.test(ref)) {
      throw new ApiError(400, "A valid payment reference is required.");
    }

    const tx = await collection("transactions").findOne({
      ref,
      userId: req.user._id,
      method: "upi",
    });
    if (!tx) throw new ApiError(404, "Payment request not found.");

    // Re-read the user: only admin verification flips the plan.
    const user = await collection("user").findOne({ _id: req.user._id });
    res.json({
      status: tx.status,
      utr: tx.utr ?? null,
      plan: effectivePlan(user),
      activated: isPremiumActive(user),
      subscriptionExpiresAt: user?.subscriptionExpiresAt ?? null,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/admin/transactions/:ref/verify — admin approval of a UPI payment.
 * This is the trusted event for UPI; the client never activates a plan itself.
 */
export async function verifyUpiPayment(req, res, next) {
  try {
    const { ref } = req.params;
    const { action, note } = req.body || {};
    if (!["approve", "reject"].includes(action)) {
      throw new ApiError(400, "action must be approve or reject.");
    }

    const tx = await collection("transactions").findOne({ ref, method: "upi" });
    if (!tx) throw new ApiError(404, "UPI payment not found.");
    if (tx.status === "succeeded") {
      return res.json({ ok: true, status: tx.status, message: "Already verified." });
    }
    if (tx.status !== "verifying") {
      throw new ApiError(400, "Only a submitted UPI payment can be verified.");
    }

    const now = new Date();
    await collection("transactions").updateOne(
      { _id: tx._id },
      {
        $set: {
          status: action === "approve" ? "succeeded" : "failed",
          verifiedBy: req.user._id,
          verifiedAt: now,
          paidAt: action === "approve" ? now : null,
          verificationNote: typeof note === "string" ? note.slice(0, 300) : "",
          updatedAt: now,
        },
      },
    );

    if (action === "approve") await activatePremium(tx.userId);

    res.json({
      ok: true,
      status: action === "approve" ? "succeeded" : "failed",
      message:
        action === "approve"
          ? "Payment verified and premium activated."
          : "Payment rejected.",
    });
  } catch (err) {
    next(err);
  }
}
