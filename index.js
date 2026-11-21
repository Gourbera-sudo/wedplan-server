import "dotenv/config";

import { createApp } from "./src/app.js";
import { env } from "./src/config/env.js";
import { connectDatabase } from "./src/config/db.js";

async function main() {
  await connectDatabase();
  const app = createApp();
  app.listen(env.port, () => {
    console.log(`wedplan-server listening on http://localhost:${env.port}`);
    console.log(`Allowed client origin: ${env.clientUrl}`);
  });
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
