import "dotenv/config";

import { createApp } from "../src/app.js";
import { connectDatabase } from "../src/config/db.js";

// Vercel calls this module directly. Keeping the Express app cached avoids a
// fresh Mongo connection on every serverless invocation.
export const config = {
  api: {
    // Stripe signs the exact bytes it sends, so Vercel must not parse the body.
    bodyParser: false,
  },
};

let appPromise;

function getApp() {
  if (!appPromise) {
    appPromise = connectDatabase().then(() => createApp());
  }
  return appPromise;
}

export default async function handler(req, res) {
  const app = await getApp();
  return app(req, res);
}
