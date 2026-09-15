// Read-only check against the real Community Applications catalog.
//
// Opt in with UNRAIDCLAW_LIVE_FEED=1. Skipped by default so the suite stays
// offline and deterministic. This downloads ~17MB and installs nothing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { CaFeed, searchCatalog, findApps, CA_FEED_URL } from "../src/ca-feed.js";
import { computeBlockers } from "../src/ca-template.js";

const live = process.env.UNRAIDCLAW_LIVE_FEED === "1";

test(
  "the live catalog parses and still has the shape the endpoints rely on",
  { skip: live ? false : "set UNRAIDCLAW_LIVE_FEED=1 to run", timeout: 120_000 },
  async () => {
    const feed = new CaFeed();
    const catalog = await feed.load();

    assert.ok(catalog.apps.length > 1000, `expected a large catalog, got ${catalog.apps.length}`);
    assert.ok(catalog.updated.startsWith("20"), `feed vintage looks wrong: ${catalog.updated}`);
    assert.ok(CA_FEED_URL.startsWith("https://"));

    // Search still finds a household-name app.
    const hits = searchCatalog(catalog, "jellyfin", { limit: 10 });
    assert.ok(hits.length > 0, "jellyfin is in the catalog");
    assert.ok(hits.some((a) => a.repository.includes("jellyfin")));

    // Duplicate names are real, which is why :name can answer 409.
    const plex = findApps(catalog, "plex");
    assert.ok(plex.length > 1, `expected several "plex" templates, got ${plex.length}`);

    // Config entries normalize into the three kinds the API reports.
    const withConfig = catalog.apps.find((a) => a.config.length > 3);
    assert.ok(withConfig, "some app has a template");
    for (const c of withConfig.config) {
      assert.ok(["Port", "Path", "Variable", "Label", "Device"].includes(c.type), c.type);
      if (c.type === "Port") assert.ok(["tcp", "udp"].includes(c.mode), c.mode);
    }

    // A meaningful number of apps are installable, and the refusals are real.
    const env = { unraidVersion: "7.0.0" };
    let installable = 0;
    for (const a of catalog.apps) if (computeBlockers(a, env).length === 0) installable++;
    assert.ok(installable > 500, `expected many installable apps, got ${installable}`);
    assert.ok(installable < catalog.apps.length, "some apps are correctly refused");
  }
);

test(
  "a second load reuses the cached catalog instead of re-downloading",
  { skip: live ? false : "set UNRAIDCLAW_LIVE_FEED=1 to run", timeout: 120_000 },
  async () => {
    const feed = new CaFeed();
    const first = await feed.load();
    const second = await feed.load();
    assert.equal(first, second, "same object, no second download");
  }
);
