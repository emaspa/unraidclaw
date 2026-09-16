import { run } from "../src/main.js";

// Only this fixture entry overrides local discovery; production has no test env flags.
const root = process.argv[2];
process.exitCode = await run(["config", "set-key", "--output", "json"], {
  context: { root, home: root, platform: process.platform, env: {} },
});
