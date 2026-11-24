/**
 * One-time cleanup for bookings written by the old client-side server action:
 * string IDs, capitalized statuses, and missing denormalized display fields.
 * Safe to re-run — it only touches documents whose shape is legacy.
 *
 * Run: node scripts/migrate-bookings.mjs
 */
import "dotenv/config";
import { MongoClient, ObjectId } from "mongodb";

const client = new MongoClient(process.env.MONGODB_URI);
await client.connect();

try {
  const db = client.db("wed-plan");
  const bookings = db.collection("bookings");
  const legacy = await bookings
    .find({
      $or: [
        { serviceId: { $type: "string" } },
        { customerId: { $type: "string" } },
        { status: { $in: ["Pending", "Accepted", "Rejected", "Cancelled"] } },
      ],
    })
    .toArray();

  let migrated = 0;
  for (const booking of legacy) {
    const $set = {};

    const service = booking.serviceId
      ? await db
          .collection("services")
          .findOne({ _id: new ObjectId(String(booking.serviceId)) })
          .catch(() => null)
      : null;

    for (const field of ["serviceId", "vendorId", "customerId"]) {
      const value = booking[field];
      if (typeof value === "string" && ObjectId.isValid(value)) {
        $set[field] = new ObjectId(value);
      } else if (!value && field === "vendorId" && service) {
        $set[field] = service.vendorId;
      }
    }

    if (typeof booking.status === "string") {
      $set.status = booking.status.toLowerCase();
    }

    if (service) {
      if (!booking.serviceName) $set.serviceName = service.name;
      if (!booking.serviceImage) $set.serviceImage = service.image || "";
      if (!booking.serviceCategory) $set.serviceCategory = service.category;
      if (!booking.vendorName) $set.vendorName = service.vendorName || "";
    }

    const customer = booking.customerId
      ? await db
          .collection("user")
          .findOne({ _id: new ObjectId(String(booking.customerId)) })
          .catch(() => null)
      : null;
    if (customer) {
      if (!booking.customerName) $set.customerName = customer.name;
      if (!booking.customerEmail) $set.customerEmail = customer.email;
    }

    $set.updatedAt = new Date();
    await bookings.updateOne({ _id: booking._id }, { $set });
    migrated += 1;
  }

  console.log(`Normalized ${migrated} legacy booking(s).`);
} finally {
  await client.close();
}
