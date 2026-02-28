import { loadConfig, loadPermissions, watchPermissions } from "./config.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const permissions = loadPermissions();

  console.log("[unraidclaw] Loaded permissions:", Object.values(permissions).filter(Boolean).length, "enabled");

  // Watch for permission changes (hot-reload)
  watchPermissions((matrix) => {
    console.log("[unraidclaw] Permissions reloaded:", Object.values(matrix).filter(Boolean).length, "enabled");
  });

  const app = createServer(config);

  try {
    await app.listen({ port: config.port, host: config.host });
    console.log(`[unraidclaw] Server running on ${config.host}:${config.port}`);
  } catch (err) {
    console.error("[unraidclaw] Failed to start:", err);
    process.exit(1);
  }

  // Graceful shutdown
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, async () => {
      console.log(`[unraidclaw] Received ${signal}, shutting down...`);
      await app.close();
      process.exit(0);
    });
  }
}

main();
