import type { FastifyInstance } from "fastify";
import { runCommand, validBody, type CommandRunner } from "../docker-common.js";
import { Resource, Action } from "@unraidclaw/shared";
import type { GraphQLClient } from "../graphql-client.js";
import { requirePermission } from "../permissions.js";

function humanSize(kilobytes: number): string {
  if (kilobytes < 1024) return `${kilobytes} KiB`;
  const mib = kilobytes / 1024;
  if (mib < 1024) return `${mib.toFixed(1)} MiB`;
  const gib = mib / 1024;
  if (gib < 1024) return `${gib.toFixed(1)} GiB`;
  const tib = gib / 1024;
  return `${tib.toFixed(2)} TiB`;
}

const STATUS_QUERY = `query {
  array {
    state
    capacity {
      kilobytes { free used total }
    }
    disks {
      name
      device
      size
      status
      temp
      fsType
      color
    }
    parities {
      name
      device
      size
      status
      numErrors
    }
  }
}`;

const SET_STATE_MUTATION = `mutation ($input: ArrayStateInput!) {
  array {
    setState(input: $input) {
      state
    }
  }
}`;

// Parity-check status is read from `mdcmd status` (the live md-driver state the
// webGUI itself uses) rather than the GraphQL `array.parityCheckStatus` field,
// which does not reflect checks started outside Connect (see issue #14).
type MdState = Record<string, string>;

async function readMdcmdStatus(run: CommandRunner): Promise<MdState> {
  const { stdout: out } = await run("mdcmd", ["status"], { timeout: 10000 });
  const state: MdState = {};
  for (const line of out.split("\n")) {
    const eq = line.indexOf("=");
    if (eq !== -1) state[line.slice(0, eq)] = line.slice(eq + 1);
  }
  if (state.mdResync === undefined || !/^\d+$/.test(state.mdResync)
    || (state.mdResyncPos !== undefined && !/^\d+$/.test(state.mdResyncPos))) {
    throw new Error("Invalid mdcmd status: missing or invalid resync state");
  }
  return state;
}

function mdNum(v: string | undefined): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

type ParityState = "running" | "paused" | "idle";

function parityState(md: MdState): ParityState {
  return mdNum(md.mdResync) > 0 ? "running" : mdNum(md.mdResyncPos) > 0 ? "paused" : "idle";
}

// The md driver applies a check command almost at once, but poll for a few
// seconds so a slow transition is not reported as a failure.
async function waitForParity(run: CommandRunner, expected: ParityState, intervalMs: number): Promise<ParityState> {
  let state = parityState(await readMdcmdStatus(run));
  for (let attempt = 1; attempt < 10 && state !== expected; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    state = parityState(await readMdcmdStatus(run));
  }
  return state;
}

export function registerArrayRoutes(app: FastifyInstance, gql: GraphQLClient, run: CommandRunner = runCommand, pollIntervalMs = 500): void {
  // Array status
  app.get("/api/array/status", {
    preHandler: requirePermission(Resource.ARRAY, Action.READ),
    handler: async (_req, reply) => {
      const data = await gql.query<{ array: Record<string, unknown> }>(STATUS_QUERY);
      const arr = data.array as Record<string, unknown>;
      // Add human-readable capacity
      const cap = arr.capacity as Record<string, unknown> | undefined;
      if (cap) {
        const kb = cap.kilobytes as Record<string, number> | undefined;
        if (kb) {
          (cap as Record<string, unknown>).human = {
            free: humanSize(kb.free),
            used: humanSize(kb.used),
            total: humanSize(kb.total),
          };
        }
      }
      // Add human-readable disk sizes
      const enrichDisks = (list: unknown[]) =>
        list.map((d) => {
          const disk = d as Record<string, unknown>;
          return typeof disk.size === "number"
            ? { ...disk, sizeHuman: humanSize(disk.size as number) }
            : disk;
        });
      if (Array.isArray(arr.disks)) arr.disks = enrichDisks(arr.disks);
      if (Array.isArray(arr.parities)) arr.parities = enrichDisks(arr.parities);
      return reply.send({ ok: true, data: arr });
    },
  });

  // Parity status (from `mdcmd status`, see note above and issue #14)
  app.get("/api/array/parity/status", {
    preHandler: requirePermission(Resource.ARRAY, Action.READ),
    handler: async (_req, reply) => {
      try {
        const s = await readMdcmdStatus(run);
        const position = mdNum(s.mdResyncPos);
        const size = mdNum(s.mdResyncSize);
        const dt = mdNum(s.mdResyncDt);
        const db = mdNum(s.mdResyncDb);
        // A check is in progress while the resync position is non-zero
        // (mdResyncSize/mdResyncAction persist when idle, so they can't gate this).
        const running = position > 0 || mdNum(s.mdResync) > 0;
        // KiB/s, mirroring Unraid's mdResyncDb/mdResyncDt (instantaneous; the webGUI
        // shows an averaged-since-start figure, so the two differ slightly mid-ramp).
        const speed = dt > 0 ? db / dt : 0;
        const progress = size > 0 ? Math.min(100, (position / size) * 100) : 0;
        const errors = mdNum(s.sbSyncErrs);
        const started = mdNum(s.sbSynced);
        const finished = mdNum(s.sbSynced2);
        return reply.send({
          ok: true,
          data: {
            // Backward-compatible shape (previously from GraphQL parityCheckStatus)
            running,
            progress: Number(progress.toFixed(2)),
            speed, // KiB/s
            errors,
            // Richer fields available from mdcmd status
            paused: running && mdNum(s.mdResync) === 0, // position retained while the driver is paused
            action: s.mdResyncAction || null, // e.g. "check P Q", "recon", "clear"
            correcting: mdNum(s.mdResyncCorr) === 1,
            position, // KB completed
            size, // KB total
            // MB/s (decimal) to match the Unraid webGUI's parity-speed display
            speedHuman: speed > 0 ? `${((speed * 1024) / 1e6).toFixed(1)} MB/s` : null,
            lastCheck: {
              started: started || null,
              finished: finished || null,
              durationSec: started && finished ? finished - started : null,
              exitStatus: s.sbSyncExit !== undefined ? mdNum(s.sbSyncExit) : null,
              errors,
            },
          },
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return reply.status(500).send({ ok: false, error: { code: "MDCMD_ERROR", message: msg } });
      }
    },
  });

  // Start array
  app.post("/api/array/start", {
    preHandler: requirePermission(Resource.ARRAY, Action.UPDATE),
    handler: async (_req, reply) => {
      const data = await gql.query<{ array: { setState: { state: string } } }>(
        SET_STATE_MUTATION,
        { input: { desiredState: "START" } },
      );
      // The mutation can return before emhttp finishes the transition, so a
      // different state is reported as unverified rather than as a failure.
      return reply.send({ ok: true, data: { ...data.array.setState, verified: data.array.setState.state === "STARTED" } });
    },
  });

  // Stop array
  app.post("/api/array/stop", {
    preHandler: requirePermission(Resource.ARRAY, Action.UPDATE),
    handler: async (_req, reply) => {
      const data = await gql.query<{ array: { setState: { state: string } } }>(
        SET_STATE_MUTATION,
        { input: { desiredState: "STOP" } },
      );
      // The mutation can return before emhttp finishes the transition, so a
      // different state is reported as unverified rather than as a failure.
      return reply.send({ ok: true, data: { ...data.array.setState, verified: data.array.setState.state === "STOPPED" } });
    },
  });

  // Start parity check
  app.post<{ Body?: { correct?: boolean } }>("/api/array/parity/start", {
    preHandler: requirePermission(Resource.ARRAY, Action.UPDATE),
    handler: async (req, reply) => {
      if (!validBody(req.body === undefined ? {} : req.body, ["correct"]) || (req.body?.correct !== undefined && typeof req.body.correct !== "boolean")) {
        return reply.status(400).send({ ok: false, error: { code: "VALIDATION_ERROR", message: "Only a boolean correct field is accepted" } });
      }
      const correct = req.body?.correct ?? false;
      const mode = correct ? "CORRECT" : "NOCORRECT";
      try {
        await run("mdcmd", ["check", mode], { timeout: 10000 });
        const state = await waitForParity(run, "running", pollIntervalMs);
        if (state !== "running") return reply.status(500).send({ ok: false, error: { code: "VERIFICATION_FAILED", message: "Parity check did not reach running" }, data: { state, verified: false } });
        return reply.send({ ok: true, data: { verified: true, message: `Parity check started (${mode})` } });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ ok: false, error: { code: "MDCMD_ERROR", message: msg } });
      }
    },
  });

  // Pause parity check
  app.post("/api/array/parity/pause", {
    preHandler: requirePermission(Resource.ARRAY, Action.UPDATE),
    handler: async (_req, reply) => {
      try {
        await run("mdcmd", ["nocheck", "PAUSE"], { timeout: 10000 });
        const state = await waitForParity(run, "paused", pollIntervalMs);
        if (state !== "paused") return reply.status(500).send({ ok: false, error: { code: "VERIFICATION_FAILED", message: "Parity check did not reach paused" }, data: { state, verified: false } });
        return reply.send({ ok: true, data: { verified: true, message: "Parity check paused" } });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ ok: false, error: { code: "MDCMD_ERROR", message: msg } });
      }
    },
  });

  // Resume parity check
  app.post("/api/array/parity/resume", {
    preHandler: requirePermission(Resource.ARRAY, Action.UPDATE),
    handler: async (_req, reply) => {
      try {
        await run("mdcmd", ["check", "RESUME"], { timeout: 10000 });
        const state = await waitForParity(run, "running", pollIntervalMs);
        if (state !== "running") return reply.status(500).send({ ok: false, error: { code: "VERIFICATION_FAILED", message: "Parity check did not reach running" }, data: { state, verified: false } });
        return reply.send({ ok: true, data: { verified: true, message: "Parity check resumed" } });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ ok: false, error: { code: "MDCMD_ERROR", message: msg } });
      }
    },
  });

  // Cancel parity check
  app.post("/api/array/parity/cancel", {
    preHandler: requirePermission(Resource.ARRAY, Action.UPDATE),
    handler: async (_req, reply) => {
      try {
        await run("mdcmd", ["nocheck", "CANCEL"], { timeout: 10000 });
        const state = await waitForParity(run, "idle", pollIntervalMs);
        if (state !== "idle") return reply.status(500).send({ ok: false, error: { code: "VERIFICATION_FAILED", message: "Parity check did not reach idle" }, data: { state, verified: false } });
        return reply.send({ ok: true, data: { verified: true, message: "Parity check cancelled" } });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ ok: false, error: { code: "MDCMD_ERROR", message: msg } });
      }
    },
  });

}
