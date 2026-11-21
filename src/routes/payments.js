import Stripe from "stripe";
import { ObjectId } from "mongodb";

import { env } from "../config/env.js";
import { collection } from "../config/db.js";
import { ApiError } from "../middleware/error.js";

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

/**
 * POST /api/payments/checkout — creates a Stripe Checkout session for the
 * premium plan. The session id is stored so the webhook can match it later;
 * nothing about the subscription is trusted from the client.
 */
export async function createCheckout(req, res, next) {
  try {
    if (req.user.subscriptionPlan === "premium") {
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

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const userId = session.metadata?.userId;

      await collection("transactions").updateOne(
        { stripeSessionId: session.id },
        {
          $set: {
            status: "succeeded",
            stripePaymentIntent: session.payment_intent || null,
            paidAt: new Date(),
          },
        },
      );

      // Activate premium for 30 days — only now, from a verified event.
      if (userId && ObjectId.isValid(userId)) {
        const expires = new Date();
        expires.setDate(expires.getDate() + 30);

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
      // The page should trust this flag, which only the webhook can set true.
      activated: user?.subscriptionPlan === "premium",
      transaction: tx || null,
    });
  } catch (err) {
    next(err);
  }
}
