import "dotenv/config";

const required = ["MONGODB_URI", "JWT_SECRET", "BETTER_AUTH_SECRET"];
const missing = required.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error(
    `Missing required environment variables: ${missing.join(", ")}. Copy .env.example to .env and fill them in.`,
  );
  process.exit(1);
}

export const env = {
  port: Number(process.env.PORT || 8000),
  /** Origin of the Next.js client — used for CORS and Stripe redirect URLs. */
  clientUrl: process.env.CLIENT_URL || "http://localhost:3000",
  mongoUri: process.env.MONGODB_URI,
  databaseName: "wed-plan",
  /** Shared with the client so it can mint session JWTs for API calls. */
  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "1h",
  /** Shared with better-auth so this server can verify session cookies. */
  betterAuthSecret: process.env.BETTER_AUTH_SECRET || "",
  stripeSecretKey: process.env.STRIPE_SECRET_KEY || "",
  stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET || "",
  imgbbApiKey: process.env.IMGBB_API_KEY || "",
  /** UPI subscription: payee VPA + optional display name. */
  upiVpa: process.env.UPI_VPA || "",
  upiPayeeName: process.env.UPI_PAYEE_NAME || "WedPlan",
  /** Premium price for UPI, in paise (default ₹499). */
  upiMonthlyPaise: Number(process.env.UPI_MONTHLY_PAISE || 49900),
};
