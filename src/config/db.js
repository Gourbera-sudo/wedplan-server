import { MongoClient } from "mongodb";

import { env } from "./env.js";

let client;
let db;

/**
 * Opens the shared connection (once) and ensures the indexes the API relies
 * on exist. Safe to call from multiple request handlers.
 */
export async function connectDatabase() {
  if (db) return db;

  client = new MongoClient(env.mongoUri);
  await client.connect();
  db = client.db(env.databaseName);

  await Promise.all([
    db
      .collection("services")
      .createIndex({ status: 1, isActive: 1, createdAt: -1 }),
    db.collection("services").createIndex({ vendorId: 1 }),
    db.collection("bookings").createIndex({ vendorId: 1, status: 1 }),
    db.collection("bookings").createIndex({ customerId: 1, createdAt: -1 }),
    db
      .collection("bookings")
      .createIndex(
        { serviceId: 1, customerId: 1, eventDate: 1 },
        {
          name: "one_active_booking_per_date",
          unique: true,
          partialFilterExpression: {
            status: { $in: ["pending", "accepted"] },
          },
        },
      ),
    db
      .collection("transactions")
      .createIndex({ stripeSessionId: 1 }, { unique: true }),
    db.collection("transactions").createIndex({ userId: 1 }),
  ]);

  return db;
}

export function getDatabase() {
  if (!db) throw new Error("Database not connected — call connectDatabase() first.");
  return db;
}

export function collection(name) {
  return getDatabase().collection(name);
}
