import { buildApp } from "./app.js";
import { env } from "./config/env.js";
import { reaperWorker } from "./workers/reaper.worker.js";

async function main() {
  const app = buildApp();

  try {
    await app.listen({ port: env.PORT, host: env.HOST });
    console.log(`FlashLock server running on http://${env.HOST}:${env.PORT}`);

    // Start background reaper worker (1s loop)
    reaperWorker.start(1000);
    console.log("Reaper worker started (1s interval)");
  } catch (err) {
    console.error("Error starting FlashLock server:", err);
    process.exit(1);
  }
}

main();
