/**
 * Repeatable demo seed for wedplan-server.
 *
 * Run: node scripts/seed.js   (reads .env, never commits secrets)
 *
 * Idempotent: users are matched by email, services by slug, and every run
 * resets them to the documented demo state so you can re-seed at any time.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { MongoClient, ObjectId } from "mongodb";
import { hashPassword } from "@better-auth/utils/password";

const envPath = join(dirname(fileURLToPath(import.meta.url)), "..", ".env");
const env = Object.fromEntries(
  readFileSync(envPath, "utf8")
    .split(/\r?\n/)
    .filter((line) => /^[A-Za-z0-9_]+=/.test(line))
    .map((line) => {
      const i = line.indexOf("=");
      return [line.slice(0, i), line.slice(i + 1).replace(/^["']|["']$/g, "")];
    }),
);

const uri = env.MONGODB_URI;
if (!uri) {
  console.error("MONGODB_URI is not set in .env");
  process.exit(1);
}

const image = (id) =>
  `https://images.unsplash.com/${id}?auto=format&fit=crop&w=1200&q=80`;

// Configurable in .env; matches the client auth password rule.
const DEMO_PASSWORD = process.env.ADMIN_PASSWORD || "Wedplan1!";
if (!/^(?=.*[a-z])(?=.*[A-Z]).{6,}$/.test(DEMO_PASSWORD)) {
  console.error(
    "ADMIN_PASSWORD in .env must be 6+ characters with one uppercase and one lowercase letter.",
  );
  process.exit(1);
}

const users = [
  {
    email: "admin@wedplan.test",
    name: "Ava Admin",
    role: "admin",
    isBlocked: false,
    subscriptionPlan: "free",
  },
  {
    email: "vendor@wedplan.test",
    name: "Vikram Venues",
    role: "vendor",
    businessName: "Willow House Estates",
    isBlocked: false,
    subscriptionPlan: "free",
  },
  {
    email: "vendor2@wedplan.test",
    name: "Priya Lens",
    role: "vendor",
    businessName: "Priya Lens Studios",
    isBlocked: false,
    subscriptionPlan: "premium",
    subscriptionExpiresAt: new Date(Date.now() + 25 * 864e5),
  },
  {
    email: "customer@wedplan.test",
    name: "Cara Customer",
    role: "customer",
    isBlocked: false,
    subscriptionPlan: "free",
  },
  {
    email: "blocked@wedplan.test",
    name: "Ben Blocked",
    role: "customer",
    isBlocked: true,
    subscriptionPlan: "free",
  },
];

const services = [
  {
    slug: "the-willow-house",
    name: "The Willow House",
    category: "Wedding Venues",
    ownerEmail: "vendor@wedplan.test",
    description:
      "A light-filled garden estate for ceremonies and receptions under the old willow tree.",
    location: "Portland, OR",
    price: 6400,
    image: image("photo-1519741497674-611481863552"),
    featured: true,
    order: 1,
    isApproved: true,
    status: "approved",
  },
  {
    slug: "silver-oak-photography",
    name: "Silver Oak Photography",
    category: "Photography & Videography",
    ownerEmail: "vendor2@wedplan.test",
    description:
      "Documentary wedding photography with a fine-art edit and a full-day timeline.",
    location: "Seattle, WA",
    price: 3200,
    image: image("photo-1511285560929-80b456fea0bc"),
    featured: true,
    order: 2,
    isApproved: true,
    status: "approved",
  },
  {
    slug: "bloom-and-bramble",
    name: "Bloom & Bramble Florals",
    category: "Decoration & Florist",
    ownerEmail: "vendor@wedplan.test",
    description:
      "Seasonal arrangements, ceremony arches and reception tablescapes.",
    location: "Portland, OR",
    price: 1800,
    image: image("photo-1465495976277-4387d4b0b4c6"),
    featured: true,
    order: 3,
    isApproved: true,
    status: "approved",
  },
  {
    slug: "golden-hour-catering",
    name: "Golden Hour Catering",
    category: "Catering Services",
    ownerEmail: "vendor@wedplan.test",
    description:
      "Plated and buffet menus with tastings, staff and bar service included.",
    location: "Austin, TX",
    price: 4500,
    image: image("photo-1555244162-803834f70033"),
    featured: true,
    order: 4,
    isApproved: true,
    status: "approved",
  },
  {
    slug: "rouge-atelier-makeup",
    name: "Rouge Atelier Makeup",
    category: "Makeup & Styling",
    ownerEmail: "vendor2@wedplan.test",
    description:
      "Bridal hair and makeup trials plus on-location party packages.",
    location: "Los Angeles, CA",
    price: 950,
    image: image("photo-1487412720507-e7ab37603c6f"),
    featured: true,
    order: 5,
    isApproved: true,
    status: "approved",
  },
  {
    slug: "atelier-noor-couture",
    name: "Atelier Noor Couture",
    category: "Wedding Fashion",
    ownerEmail: "vendor2@wedplan.test",
    description:
      "Custom bridal gowns and tailored suits with three fitting sessions.",
    location: "New York, NY",
    price: 2800,
    image: image("photo-1594552072238-b8a33785b261"),
    featured: true,
    order: 6,
    isApproved: true,
    status: "approved",
  },
  {
    slug: "moonlight-dj-crew",
    name: "Moonlight DJ Crew",
    category: "Wedding Venues",
    ownerEmail: "vendor@wedplan.test",
    description: "Reception sound, lighting and a live-mix DJ set.",
    location: "Denver, CO",
    price: 1200,
    image: image("photo-1470225620780-dba8ba36b745"),
    featured: false,
    order: 90,
    isApproved: false, // pending — hidden from the public site
    status: "pending",
  },
  {
    slug: "rejected-limo-service",
    name: "City Limo Service",
    category: "Wedding Venues",
    ownerEmail: "vendor@wedplan.test",
    description: "Submitted without insurance documents — rejected by admin.",
    location: "Chicago, IL",
    price: 700,
    image: image("photo-1449965408869-eaa3f722e40d"),
    featured: false,
    order: 91,
    isApproved: false, // rejected — must never appear publicly
    status: "rejected",
  },
];

async function seed() {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db("wed-plan");

  // Remove demo docs written by the old client-side seed — the server now
  // owns the data, and those rows lack vendorId/ownership fields.
  const stale = await db
    .collection("services")
    .deleteMany({ seedMarker: "wedplan-demo" });
  if (stale.deletedCount) {
    console.log(`Removed ${stale.deletedCount} legacy client-seeded services.`);
  }

  console.log("Seeding users...");
  for (const u of users) {
    const passwordHash = await hashPassword(DEMO_PASSWORD);
    const now = new Date();
    const existing = await db.collection("user").findOne({ email: u.email });
    const doc = {
      name: u.name,
      email: u.email,
      role: u.role,
      businessName: u.businessName || "",
      isBlocked: u.isBlocked,
      banned: u.isBlocked, // better-auth admin plugin flag, kept in sync
      subscriptionPlan: u.subscriptionPlan,
      subscriptionExpiresAt: u.subscriptionExpiresAt || null,
      image: "",
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    };
    let userId;
    if (existing) {
      await db.collection("user").updateOne(
        { _id: existing._id },
        { $set: doc },
      );
      userId = existing._id;
    } else {
      const result = await db.collection("user").insertOne({
        ...doc,
        password: passwordHash,
      });
      userId = result.insertedId;
    }

    // better-auth credential row: accountId must equal the user id, and the
    // hash must be the one better-auth's verify() accepts. Upserted every run
    // so re-seeding repairs any drift.
    await db.collection("account").updateOne(
      { userId, providerId: "credential" },
      {
        $set: {
          accountId: String(userId),
          password: passwordHash,
          updatedAt: now,
        },
        $setOnInsert: {
          _id: new ObjectId(),
          providerId: "credential",
          createdAt: now,
        },
      },
      { upsert: true },
    );
    console.log(`  ✓ ${u.email} (${u.role}${u.isBlocked ? ", blocked" : ""})`);
  }

  console.log("Seeding services...");
  const emailToId = new Map(
    (await db.collection("user").find({}).toArray()).map((u) => [u.email, u]),
  );
  for (const s of services) {
    const owner = emailToId.get(s.ownerEmail);
    if (!owner) throw new Error(`Owner ${s.ownerEmail} missing — seed users first.`);
    const now = new Date();
    const doc = {
      slug: s.slug,
      name: s.name,
      category: s.category,
      description: s.description,
      location: s.location,
      price: s.price,
      image: s.image,
      images: [s.image],
      featured: s.featured,
      order: s.order,
      eventTypes: ["Wedding"],
      availability: "Year-round",
      vendorId: owner._id,
      vendorName: owner.name,
      vendorBusinessName: owner.businessName || "",
      vendorVerified: owner.subscriptionPlan === "premium",
      isActive: true,
      isApproved: s.isApproved,
      status: s.status,
      seedMarker: "wedplan-server-seed",
      createdAt: now,
      updatedAt: now,
    };
    await db
      .collection("services")
      .updateOne({ slug: s.slug }, { $set: doc }, { upsert: true });
    console.log(`  ✓ ${s.name} (${s.status})`);
  }

  console.log("\nSeed complete. Demo sign-ins:");
  console.log(`  admin    admin@wedplan.test    / ${DEMO_PASSWORD}`);
  console.log(`  vendor   vendor@wedplan.test   / ${DEMO_PASSWORD}  (free plan)`);
  console.log(`  vendor   vendor2@wedplan.test  / ${DEMO_PASSWORD}  (premium)`);
  console.log(`  customer customer@wedplan.test / ${DEMO_PASSWORD}`);
  console.log(`  blocked  blocked@wedplan.test  / ${DEMO_PASSWORD}`);

  await client.close();
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
