/**
 * End-to-end smoke test for wedplan-server.
 *
 * Run: node scripts/smoke-test.mjs
 *
 * Signs in through the running Next.js client (better-auth) to obtain session
 * cookies, exchanges them for API JWTs, then asserts the role/ownership/booking
 * rules. Exits non-zero if any check fails.
 */
const API = process.env.API_URL || "http://localhost:8000";
const CLIENT = process.env.CLIENT_URL || "http://localhost:3000";
const PASSWORD = "Wedplan1!";
const TEST_EVENT_DATE = "2027-06-15";

import "dotenv/config";
import { MongoClient } from "mongodb";

/** Wipes bookings from earlier runs so the suite is deterministic. */
async function resetTestBookings() {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  await client
    .db("wed-plan")
    .collection("bookings")
    .deleteMany({ eventDate: new Date(TEST_EVENT_DATE) });
  await client.close();
}

let passed = 0;
const failures = [];

function check(name, ok, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(`${name} ${detail}`);
    console.log(`  ✗ ${name} ${detail}`);
  }
}

/** better-auth sign-in on the client; returns the session cookie string. */
async function signIn(email) {
  const res = await fetch(`${CLIENT}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: CLIENT },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`sign-in failed for ${email}: ${res.status}`);
  const setCookie = res.headers.getSetCookie?.() || [];
  const token = setCookie
    .map((c) => c.split(";")[0])
    .find((c) => c.startsWith("better-auth.session_token="));
  if (!token) throw new Error(`no session cookie for ${email}`);
  return token;
}

/** Session cookie → wedplan-server API JWT. */
async function getToken(cookie) {
  const res = await fetch(`${API}/api/auth/token`, {
    method: "POST",
    headers: { Cookie: cookie },
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status}`);
  return (await res.json()).token;
}

async function api(token, path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON */
  }
  return { status: res.status, body };
}

async function main() {
  console.log("\n1. Public endpoints");
  const health = await api(null, "/api/health");
  check("health", health.status === 200 && health.body?.ok === true);

  const list = await api(null, "/api/services");
  check(
    "public list hides unapproved services",
    list.status === 200 && list.body.services.every((s) => s.isApproved && s.isActive),
    `(got ${list.body?.services?.length})`,
  );
  check(
    "public list returns approved services",
    list.body?.services?.length >= 6,
    `(got ${list.body?.services?.length})`,
  );

  const search = await api(null, "/api/services?search=willow");
  check("search by name", search.body?.services?.some((s) => s.name.includes("Willow")));

  const byCat = await api(null, "/api/services?category=Catering%20Services");
  check(
    "category filter",
    byCat.body?.services?.length > 0 &&
      byCat.body.services.every((s) => s.category === "Catering Services"),
  );

  const byLoc = await api(null, "/api/services?location=portland");
  check("location filter (case-insensitive)", byLoc.body?.services?.length === 2);

  const asc = await api(null, "/api/services?sort=price_asc");
  const desc = await api(null, "/api/services?sort=price_desc");
  const ascPrices = asc.body.services.map((s) => s.price);
  const descPrices = desc.body.services.map((s) => s.price);
  check(
    "price sort asc/desc",
    ascPrices.every((p, i) => i === 0 || p >= ascPrices[i - 1]) &&
      descPrices.every((p, i) => i === 0 || p <= descPrices[i - 1]),
  );

  const featured = await api(null, "/api/services/featured");
  check("featured returns up to 6", featured.body?.services?.length === 6);

  const pendingId = (
    await api(null, "/api/services?search=moonlight")
  ).body.services[0];
  check("pending service hidden from public list", !pendingId);

  const anyService = asc.body.services[0];
  const detail = await api(null, `/api/services/${anyService._id}`);
  check("public detail view", detail.status === 200);

  console.log("\n2. Authentication");
  const customerCookie = await signIn("customer@wedplan.test");
  const customerToken = await getToken(customerCookie);
  check("customer gets JWT", Boolean(customerToken));

  const me = await api(customerToken, "/api/auth/me");
  check(
    "/me returns profile with role",
    me.status === 200 && me.body.user.role === "customer",
  );

  const noAuth = await api(null, "/api/auth/me");
  check("no token → 401", noAuth.status === 401);

  const badAuth = await api("not-a-real-token", "/api/auth/me");
  check("garbage token → 401", badAuth.status === 401);

  console.log("\n3. Role enforcement");
  const adminToken = await getToken(await signIn("admin@wedplan.test"));
  const vendorToken = await getToken(await signIn("vendor@wedplan.test"));
  const vendor2Token = await getToken(await signIn("vendor2@wedplan.test"));

  const customerOnAdmin = await api(customerToken, "/api/admin/users");
  check("customer → /admin/users = 403", customerOnAdmin.status === 403);

  const vendorOnAdmin = await api(vendorToken, "/api/admin/users");
  check("vendor → /admin/users = 403", vendorOnAdmin.status === 403);

  const adminOnAdmin = await api(adminToken, "/api/admin/users");
  check("admin → /admin/users = 200", adminOnAdmin.status === 200);

  // better-auth refuses to sign a blocked account in at all.
  let blockedSignIn = null;
  try {
    await signIn("blocked@wedplan.test");
  } catch (err) {
    blockedSignIn = err;
  }
  check(
    "blocked user cannot even sign in (403)",
    blockedSignIn !== null && /403/.test(blockedSignIn.message),
    `(got ${blockedSignIn?.message})`,
  );

  const customerOnVendorRoute = await api(customerToken, "/api/vendor/services");
  check("customer → /vendor/services = 403", customerOnVendorRoute.status === 403);

  console.log("\n4. Booking rules");
  await resetTestBookings();
  // Use the vendor-owned Willow listing so the same booking can later be
  // accepted by vendorToken; catalogue seeds may add other venues.
  const willow = await api(null, "/api/services?search=willow");
  const bookable = willow.body.services[0];
  const eventDate = TEST_EVENT_DATE;

  const selfBook = await api(customerToken, "/api/bookings", {
    method: "POST",
    body: JSON.stringify({ serviceId: bookable._id, eventDate }),
  });
  check("first booking created (pending)", selfBook.status === 201);

  const dupBook = await api(customerToken, "/api/bookings", {
    method: "POST",
    body: JSON.stringify({ serviceId: bookable._id, eventDate }),
  });
  check("duplicate booking → 409", dupBook.status === 409);

  const vendorSelfBook = await api(vendorToken, "/api/bookings", {
    method: "POST",
    body: JSON.stringify({ serviceId: bookable._id, eventDate }),
  });
  check("vendor cannot book own service → 400", vendorSelfBook.status === 400);

  const bookingId = selfBook.body.booking._id;
  const wrongDecider = await api(customerToken, `/api/bookings/${bookingId}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "accepted" }),
  });
  check("customer cannot accept → 403", wrongDecider.status === 403);

  const accept = await api(vendorToken, `/api/bookings/${bookingId}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "accepted" }),
  });
  check("vendor accepts pending booking", accept.status === 200);

  const redecide = await api(vendorToken, `/api/bookings/${bookingId}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "rejected" }),
  });
  check("already-decided booking → 409", redecide.status === 409);

  const cancelAfter = await api(customerToken, `/api/bookings/${bookingId}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "cancelled" }),
  });
  check("cannot cancel an accepted booking → 409", cancelAfter.status === 409);

  console.log("\n5. Vendor service management + free-plan cap");
  // Remove leftovers from any earlier crashed run so counts are deterministic.
  const before = await api(adminToken, "/api/admin/services");
  for (const s of before.body.services) {
    if (/^(Test Service [AB]|Premium Test Service)$/.test(s.name)) {
      await api(adminToken, `/api/vendor/services/${s._id}`, { method: "DELETE" });
    }
  }

  // vendor@wedplan.test is on the free plan and already owns 3 active
  // services (seed) — the very next create must be rejected.
  const capped = await api(vendorToken, "/api/vendor/services", {
    method: "POST",
    body: JSON.stringify({
      name: "Test Service A",
      category: "Catering Services",
      description: "Should hit the free-plan cap.",
      location: "Austin, TX",
      price: 1000,
    }),
  });
  check("free plan capped at 3 active → 403", capped.status === 403);

  // Premium vendor has no cap — this listing drives the moderation tests.
  const newService = await api(vendor2Token, "/api/vendor/services", {
    method: "POST",
    body: JSON.stringify({
      name: "Premium Test Service",
      category: "Makeup & Styling",
      description: "Premium plan has no cap.",
      location: "Los Angeles, CA",
      price: 500,
    }),
  });
  check("premium vendor creates service", newService.status === 201);
  check(
    "new service is unapproved by default",
    newService.body?.service?.isApproved === false,
  );

  const foreignEdit = await api(vendorToken, `/api/vendor/services/${newService.body.service._id}`, {
    method: "PUT",
    body: JSON.stringify({ price: 1 }),
  });
  check("vendor cannot edit another vendor's service → 403", foreignEdit.status === 403);

  const vendorServices = await api(vendorToken, "/api/vendor/services");
  const vendorMe = await api(vendorToken, "/api/auth/me");
  check(
    "vendor sees own services only (incl. unapproved)",
    vendorServices.status === 200 &&
      vendorServices.body.services.every(
        (s) => String(s.vendorId) === String(vendorMe.body.user._id),
      ),
  );

  console.log("\n6. Admin moderation + user management");
  const allServices = await api(adminToken, "/api/admin/services");
  check("admin sees every service", allServices.body?.services?.length >= 8);

  const approve = await api(adminToken, `/api/admin/services/${newService.body.service._id}`, {
    method: "PATCH",
    body: JSON.stringify({ action: "approve" }),
  });
  check("admin approves listing", approve.body?.service?.isApproved === true);

  const nowPublic = await api(null, `/api/services/${newService.body.service._id}`);
  check("approved service is publicly visible", nowPublic.status === 200);

  const reject = await api(adminToken, `/api/admin/services/${newService.body.service._id}`, {
    method: "PATCH",
    body: JSON.stringify({ action: "reject" }),
  });
  check("admin rejects listing", reject.body?.service?.isApproved === false);

  const hidden = await api(null, `/api/services/${newService.body.service._id}`);
  check("rejected service → 404 publicly", hidden.status === 404);

  const promoteAdminSelf = await api(adminToken, `/api/admin/users/${(await api(adminToken, "/api/auth/me")).body.user._id}`, {
    method: "PATCH",
    body: JSON.stringify({ role: "customer" }),
  });
  check("admin cannot change own role → 400", promoteAdminSelf.status === 400);

  const vendorUsers = adminToken
    ? (await api(adminToken, "/api/admin/users")).body.users
    : [];
  const vendorUser = vendorUsers.find((u) => u.email === "vendor@wedplan.test");
  const blockedFlip = await api(adminToken, `/api/admin/users/${vendorUser._id}`, {
    method: "PATCH",
    body: JSON.stringify({ isBlocked: true }),
  });
  check("admin blocks a user", blockedFlip.body?.user?.isBlocked === true);

  const blockedNow = await api(vendorToken, "/api/auth/me");
  check("newly blocked user locked out immediately → 403", blockedNow.status === 403);

  await api(adminToken, `/api/admin/users/${vendorUser._id}`, {
    method: "PATCH",
    body: JSON.stringify({ isBlocked: false }),
  });

  const promoteAdmin = await api(adminToken, `/api/admin/users/${vendorUser._id}`, {
    method: "PATCH",
    body: JSON.stringify({ role: "admin" }),
  });
  check("API refuses to grant admin role → 403", promoteAdmin.status === 403);

  const txList = await api(adminToken, "/api/admin/transactions");
  check("admin can list transactions", txList.status === 200);

  const vendorTx = await api(vendorToken, "/api/admin/transactions");
  check("vendor cannot view transactions → 403", vendorTx.status === 403);

  console.log("\n7. Unconfigured integrations degrade cleanly");
  const checkout = await api(customerToken, "/api/payments/checkout", {
    method: "POST",
    body: JSON.stringify({}),
  });
  check(
    "checkout without Stripe key → 503 + clear message",
    checkout.status === 503 && /STRIPE_SECRET_KEY/.test(checkout.body?.error || ""),
    `(got ${checkout.status}: ${checkout.body?.error})`,
  );

  const upload = await api(customerToken, "/api/profile/image", {
    method: "POST",
    body: JSON.stringify({ imageBase64: "aGVsbG8=" }),
  });
  check(
    "upload without ImgBB key → 503 + clear message",
    upload.status === 503 && /IMGBB_API_KEY/.test(upload.body?.error || ""),
    `(got ${upload.status}: ${upload.body?.error})`,
  );

  console.log("\n8. Profile updates");
  const profile = await api(customerToken, "/api/profile", {
    method: "PATCH",
    body: JSON.stringify({ name: "Cara Customer", bio: "Planning a spring wedding." }),
  });
  check("profile update succeeds", profile.status === 200 && profile.body.user.bio === "Planning a spring wedding.");

  const selfPromo = await api(customerToken, "/api/profile", {
    method: "PATCH",
    body: JSON.stringify({ role: "admin", subscriptionPlan: "premium" }),
  });
  check(
    "profile route ignores role/plan self-promotion",
    selfPromo.body?.user?.role === "customer" &&
      selfPromo.body.user.subscriptionPlan === "free",
  );

  // Cleanup smoke-test artifacts so re-runs are clean.
  await api(vendor2Token, `/api/vendor/services/${newService.body.service._id}`, {
    method: "DELETE",
  });
  const bookings = (await api(customerToken, "/api/bookings/mine")).body.bookings;
  for (const b of bookings) {
    await api(customerToken, `/api/bookings/${b._id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "cancelled" }),
    });
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
