/**
 * A premium plan is active only while it has not expired. Admin-granted
 * premium accounts may have no expiry, which we treat as an active plan.
 * This helper is the single source of truth for plan gating on the API.
 */
export function isPremiumActive(user) {
  if (!user || user.subscriptionPlan !== "premium") return false;
  if (!user.subscriptionExpiresAt) return true;
  return new Date(user.subscriptionExpiresAt).getTime() > Date.now();
}

/** Projection-safe plan label for API responses and UI badges. */
export function effectivePlan(user) {
  return isPremiumActive(user) ? "premium" : "free";
}
