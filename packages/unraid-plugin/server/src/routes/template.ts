// Reading and editing the saved template of an installed container.
//
// An edit changes the template, has Unraid's own docker manager build the
// command from it (scripts/docker-command), and then swaps the container the
// same careful way an app update does: the replacement is created before the
// running app is touched, everything after that targets container ids, and a
// failure at any step puts the original container back. The template on flash
// is only replaced once the rebuilt container has been checked, with a copy of
// the previous one kept first.

import type { FastifyInstance, FastifyReply } from "fastify";
import { Resource, Action } from "@unraidclaw/shared";
import type { TemplateEditPlan, TemplateEditRequest, TemplateEditResponse } from "@unraidclaw/shared";
import { copyFile, mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { requirePermission } from "../permissions.js";
import { CA_NAME_RE, CaInstallError, redactSecrets, secretValues } from "../ca-template.js";
import {
  normalizeImage,
  parseContainerFacts,
  parseSavedTemplate,
  type ContainerFacts,
  type SavedTemplate,
} from "../ca-saved-template.js";
import { applyTemplateEdit, parseTemplateEditBody, templateView } from "../template-edit.js";
import { createCaRuntime, type CaLifecycle, type CaRuntime } from "./ca.js";

const FLASH_BASE = process.env.FLASH_BASE ?? "/boot/config/plugins/unraidclaw";

export const COMMAND_SCRIPT = "/usr/local/emhttp/plugins/unraidclaw/scripts/docker-command";

const DOCKER_TIMEOUT_MS = 60_000;
const PULL_TIMEOUT_MS = 15 * 60_000;
const STOP_TIMEOUT_MS = 5 * 60_000;
/** How long a rebuilt container must stay up before it counts as started. */
const SETTLE_MS = 5_000;
/** Log lines returned when a rebuilt container does not stay up. */
const LOG_TAIL = "40";

/** Everything an edit touches outside its own process, so tests can replace it. */
export interface TemplateRuntime {
  ca: CaRuntime;
  php: string;
  commandScript: string;
  backupDir: string;
  /** Write the edited template where the command script can read it. Returns its path. */
  stageTemplate(xml: string): Promise<string>;
  discardStaged(path: string): Promise<void>;
  /** Copy the template as it is on flash now. Returns the copy's path. */
  backupTemplate(path: string, when: Date): Promise<string>;
  /** Replace the template on flash. A failed write must leave the old one in place. */
  writeTemplate(path: string, xml: string): Promise<void>;
  pathExists(path: string): Promise<boolean>;
  wait(ms: number): Promise<void>;
  settleMs: number;
  now(): Date;
}

export function createTemplateRuntime(ca: CaRuntime = createCaRuntime(), overrides: Partial<Omit<TemplateRuntime, "ca">> = {}): TemplateRuntime {
  const backupDir = overrides.backupDir ?? join(FLASH_BASE, "template-backups");
  return {
    ca,
    php: overrides.php ?? "/usr/bin/php",
    commandScript: overrides.commandScript ?? COMMAND_SCRIPT,
    backupDir,
    stageTemplate:
      overrides.stageTemplate ??
      (async (xml) => {
        // The staged copy carries the template's masked values, so it lives in
        // a directory only root can read, in RAM rather than on flash.
        const dir = await mkdtemp(join(tmpdir(), "unraidclaw-edit-"));
        const path = join(dir, "template.xml");
        await writeFile(path, xml, { encoding: "utf8", mode: 0o600 });
        return path;
      }),
    discardStaged: overrides.discardStaged ?? (async (path) => rm(dirname(path), { recursive: true, force: true })),
    backupTemplate:
      overrides.backupTemplate ??
      (async (path, when) => {
        await mkdir(backupDir, { recursive: true });
        const stamp = when.toISOString().replace(/[:.]/g, "-");
        const target = join(backupDir, `${basename(path, ".xml")}.${stamp}.xml`);
        await copyFile(path, target);
        return target;
      }),
    writeTemplate:
      overrides.writeTemplate ??
      (async (path, xml) => {
        // A rename over the old file, so a write that fails halfway leaves the
        // previous template rather than a truncated one.
        const staging = `${path}.unraidclaw-tmp`;
        await writeFile(staging, xml, { encoding: "utf8", mode: 0o600 });
        await rename(staging, path);
      }),
    pathExists:
      overrides.pathExists ??
      (async (path) => {
        try {
          await stat(path);
          return true;
        } catch {
          return false;
        }
      }),
    wait: overrides.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    settleMs: overrides.settleMs ?? SETTLE_MS,
    now: overrides.now ?? (() => new Date()),
  };
}

/** What scripts/docker-command prints. */
interface BuiltCommand {
  command: string;
  name: string;
  repository: string;
  network: string;
  requestedNetwork: string;
  extraNetworks: string[];
}

function sendError(reply: FastifyReply, status: number, code: string, message: string, details?: Record<string, unknown>) {
  return reply.status(status).send({ ok: false, error: { code, message, ...(details ? { details } : {}) } });
}

function asError(reply: FastifyReply, err: unknown) {
  if (err instanceof CaInstallError) return sendError(reply, err.statusCode, err.code, err.message, err.details);
  throw err;
}

export function registerTemplateRoutes(app: FastifyInstance, lifecycle: CaLifecycle, runtime: TemplateRuntime = createTemplateRuntime()): void {
  const { ca } = runtime;

  /** The saved template for a name, whether or not its container exists. */
  async function findTemplate(name: string): Promise<{ path: string; xml: string }> {
    if (!CA_NAME_RE.test(name)) {
      throw new CaInstallError(`Container name ${JSON.stringify(name)} is not a valid Docker container name.`, "TEMPLATE_INVALID_NAME", 400);
    }
    const wanted = `my-${name}.xml`.toLowerCase();
    const matches = (await ca.listTemplateFiles()).filter((f) => f.toLowerCase() === wanted);
    if (matches.length === 0) {
      throw new CaInstallError(`No saved template for "${name}" in ${ca.templatesDir}.`, "TEMPLATE_NOT_FOUND", 404);
    }
    if (matches.length > 1) {
      throw new CaInstallError(
        `${matches.length} saved templates match "${name}" (${matches.join(", ")}). Remove the duplicate first.`,
        "TEMPLATE_AMBIGUOUS",
        409,
        { candidates: matches }
      );
    }
    const path = join(ca.templatesDir, matches[0]);
    try {
      return { path, xml: await ca.readTemplateFile(path) };
    } catch (err) {
      throw new CaInstallError(`Could not read ${path}: ${(err as Error).message}`, "TEMPLATE_UNREADABLE", 500);
    }
  }

  /** Ask Unraid's docker manager for the command a template builds. */
  async function buildCommand(stagedPath: string, createName: string, extraVolumes: string[], secrets: string[]): Promise<BuiltCommand> {
    let stdout: string;
    try {
      ({ stdout } = await ca.run(runtime.php, [runtime.commandScript, stagedPath, createName, JSON.stringify(extraVolumes)], DOCKER_TIMEOUT_MS));
    } catch (err) {
      const e = err as Error & { stderr?: string };
      const why = redactSecrets(secrets, (e.stderr ?? "").trim() || e.message);
      throw new CaInstallError(`Unraid's docker manager could not build a command from the edited template: ${why}`, "TEMPLATE_COMMAND_FAILED", 502);
    }
    let built: BuiltCommand;
    try {
      built = JSON.parse(stdout.trim()) as BuiltCommand;
    } catch {
      throw new CaInstallError("Unraid's docker manager returned something that is not a command.", "TEMPLATE_COMMAND_FAILED", 502);
    }
    if (typeof built?.command !== "string" || built.command === "" || !Array.isArray(built.extraNetworks)) {
      throw new CaInstallError("Unraid's docker manager returned an incomplete command.", "TEMPLATE_COMMAND_FAILED", 502);
    }
    return built;
  }

  // Read an installed container's saved template.
  app.get<{ Params: { name: string } }>("/api/template/:name", {
    preHandler: requirePermission(Resource.TEMPLATE, Action.READ),
    handler: async (req, reply) => {
      try {
        const { path, xml } = await findTemplate(req.params.name);
        return reply.send({ ok: true, data: templateView(xml, path) });
      } catch (err) {
        return asError(reply, err);
      }
    },
  });

  // Change an installed container's saved template and rebuild it from it.
  app.post<{ Params: { name: string }; Body: TemplateEditRequest }>("/api/template/:name/edit", {
    preHandler: requirePermission(Resource.TEMPLATE, Action.UPDATE),
    handler: async (req, reply) => {
      const containerName = req.params.name;
      let body: TemplateEditRequest;
      try {
        body = parseTemplateEditBody(req.body);
      } catch (err) {
        return asError(reply, err);
      }

      try {
        lifecycle.claim(containerName, "edit");
      } catch (err) {
        return asError(reply, err);
      }

      let stagedPath: string | null = null;
      try {
        let tpl: SavedTemplate;
        let facts: ContainerFacts;
        try {
          ({ tpl, facts } = await lifecycle.loadInstalled(containerName));
        } catch (err) {
          return asError(reply, err);
        }
        // The saved template's own blockers are about what UnraidClaw's argv
        // cannot reproduce. Unraid builds this command itself, so they do not
        // apply here, with one exception: a name Unraid could not quote.
        if (tpl.blockers.some((b) => b.code === "CA_UNSAFE_NAME")) {
          return sendError(reply, 422, "TEMPLATE_UNSAFE_NAME", `"${containerName}" has a template name docker would not accept.`);
        }

        // A restarting container is allowed: a crash loop is often exactly
        // what an edit is for. Paused, dying and half-removed ones are not.
        if (facts.unstable && facts.status !== "restarting") {
          return sendError(
            reply,
            409,
            "TEMPLATE_UNSTABLE_STATE",
            `"${containerName}" is ${facts.status}. Nothing was changed.`,
            { status: facts.status }
          );
        }
        const wasRunning = facts.running || facts.status === "restarting";

        let edited: ReturnType<typeof applyTemplateEdit>;
        let newTpl: SavedTemplate;
        try {
          edited = applyTemplateEdit(tpl.xml, tpl.path, body);
          newTpl = parseSavedTemplate(edited.xml, tpl.path);
        } catch (err) {
          return asError(reply, err);
        }
        const secrets = secretValues([...tpl.resolved.config, ...newTpl.resolved.config]);
        const safe = (err: unknown) => redactSecrets(secrets, String((err as Error)?.message ?? err));

        const base = {
          name: containerName,
          containerId: facts.id,
          templatePath: tpl.path,
          wasRunning,
        };
        const emptyPlan: TemplateEditPlan = {
          name: containerName,
          templatePath: tpl.path,
          changes: [],
          dockerCommand: "",
          extraNetworks: [],
          hostPathsToCreate: [],
        };
        const pull = body.pull === true;
        if (edited.changes.length === 0 && !pull) {
          const response: TemplateEditResponse = {
            ...base,
            dryRun: body.dryRun === true,
            rebuilt: false,
            running: facts.running,
            plan: emptyPlan,
            warnings: ["The template already has these values, so nothing was changed or rebuilt."],
          };
          return reply.send({ ok: true, data: response });
        }

        const image = newTpl.resolved.image;
        const warnings: string[] = [];

        // A new image must be on the server before Unraid builds the command,
        // because the Tailscale hook reads its entrypoint. Otherwise an edit
        // only pulls when asked to: changing settings is not an update. With
        // "pull", it is one, for any container, whatever its template holds.
        const imagePresent = (await lifecycle.inspectJson("image", image)) !== null;
        let pulledImageId: string | undefined;
        if (!imagePresent || pull) {
          if (body.dryRun) {
            warnings.push(
              imagePresent
                ? `${image} will be pulled first. If it is newer than the image "${containerName}" runs, the container is rebuilt with it${edited.changes.length === 0 ? "; if not, nothing changes" : ""}.`
                : `${image} is not on the server yet. It will be pulled before the container is rebuilt.`
            );
          } else {
            try {
              await ca.run("docker", ["pull", image], PULL_TIMEOUT_MS);
            } catch (err) {
              return sendError(reply, 502, "TEMPLATE_PULL_FAILED", `Could not pull ${image}: ${safe(err)}. Nothing was changed.`);
            }
            try {
              pulledImageId = String(JSON.parse((await lifecycle.inspectJson("image", image)) ?? "null")?.Id ?? "") || undefined;
            } catch (err) {
              return asError(reply, err);
            }
            if (!pulledImageId) {
              return sendError(reply, 500, "TEMPLATE_IMAGE_UNREADABLE", `docker pull reported success but ${image} cannot be inspected. Nothing was changed.`);
            }
            // An update with nothing newer to run is done: rebuilding would
            // only restart the app for nothing.
            if (edited.changes.length === 0 && pulledImageId === facts.imageId) {
              const response: TemplateEditResponse = {
                ...base,
                dryRun: false,
                rebuilt: false,
                running: facts.running,
                pulled: true,
                previousImageId: facts.imageId,
                imageId: pulledImageId,
                plan: emptyPlan,
                warnings: [`${image} is already the image "${containerName}" runs, so nothing was rebuilt.`],
              };
              return reply.send({ ok: true, data: response });
            }
          }
        }

        try {
          // An update that changes no setting builds from the template exactly
          // as it is on flash, and leaves that file alone.
          stagedPath = await runtime.stageTemplate(edited.changes.length === 0 ? tpl.xml : edited.xml);
        } catch (err) {
          return sendError(reply, 500, "TEMPLATE_STAGE_FAILED", `Could not stage the edited template: ${safe(err)}. Nothing was changed.`);
        }

        // First pass: the command as Unraid builds it, to see which of the
        // running container's mounts it already covers.
        let built: BuiltCommand;
        try {
          built = await buildCommand(stagedPath, containerName, [], secrets);
        } catch (err) {
          return asError(reply, err);
        }
        if (built.name !== containerName) {
          return sendError(reply, 500, "TEMPLATE_COMMAND_FAILED", `Unraid built a command for "${built.name}", not "${containerName}". Nothing was changed.`);
        }
        // xmlToVar quietly turns a network that does not exist into "none",
        // which would rebuild the app with no network at all.
        const requested = built.requestedNetwork;
        if (requested !== "" && !requested.startsWith("container:") && built.network !== requested) {
          return sendError(
            reply,
            422,
            "TEMPLATE_UNKNOWN_NETWORK",
            `There is no docker network named "${requested}" on this server, so Unraid would put "${containerName}" on "${built.network}" instead. Nothing was changed.`
          );
        }

        // A docker volume the running container has and the new command does
        // not mount is data the app has been writing, whether a named volume
        // or one docker made from the image's own VOLUME. It is carried over by
        // name so the app does not come back with an empty one. A bind mount
        // the command no longer has is the edit's doing, or was made by hand
        // outside the template; either way it is reported, not recreated.
        // Covered means mounted at exactly that destination, in the quoted form
        // Unraid writes (-v 'src':'/dst':'rw'), a raw -v in Extra Parameters, or
        // a --mount. A plain substring test would take /cache2 for /cache and
        // leave the app with an empty volume.
        const covered = (destination: string) => {
          const d = destination.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          return new RegExp(`(?::'?${d}'?|(?:dst|target|destination)=${d})(?=[:,'\\s]|$)`).test(built.command);
        };
        const extraVolumes: string[] = [];
        for (const m of facts.mounts) {
          if (covered(m.destination)) continue;
          if (m.type === "volume" && m.name !== "" && !m.name.includes(":") && !m.destination.includes(":")) {
            extraVolumes.push(`${m.name}:${m.destination}:${m.rw ? "rw" : "ro"}`);
          } else if (m.type === "bind") {
            warnings.push(`"${m.source}" will no longer be mounted at "${m.destination}".`);
          } else {
            warnings.push(`The ${m.type || "unknown"} mount at "${m.destination}" will not be recreated.`);
          }
        }
        if (extraVolumes.length > 0) {
          warnings.push(`Carrying over ${extraVolumes.length} docker volume(s) the template does not describe, so the app keeps the data in them.`);
        }

        let shown: BuiltCommand;
        try {
          shown = extraVolumes.length > 0 ? await buildCommand(stagedPath, containerName, extraVolumes, secrets) : built;
        } catch (err) {
          return asError(reply, err);
        }

        const hostPathsToCreate: string[] = [];
        for (const c of newTpl.resolved.config) {
          if (c.type !== "Path" || c.value.trim() === "" || c.target.trim() === "") continue;
          if (!(await runtime.pathExists(c.value))) hostPathsToCreate.push(c.value);
        }

        const primary = built.network.toLowerCase();
        const extraNetworks = [...new Set(built.extraNetworks.filter((n) => n.toLowerCase() !== primary))];

        const plan: TemplateEditPlan = {
          name: containerName,
          templatePath: tpl.path,
          changes: edited.changes,
          dockerCommand: redactSecrets(secrets, shown.command),
          extraNetworks,
          hostPathsToCreate,
        };

        if (body.dryRun) {
          const response: TemplateEditResponse = { ...base, dryRun: true, rebuilt: false, running: facts.running, previousImageId: facts.imageId, plan, warnings };
          return reply.send({ ok: true, data: response });
        }

        const candidateName = `${containerName}.unraidclaw-new`;
        const rollbackName = `${containerName}.unraidclaw-old`;
        try {
          for (const reserved of [candidateName, rollbackName]) {
            if ((await lifecycle.inspectJson("container", reserved)) !== null) {
              return sendError(
                reply,
                409,
                "TEMPLATE_LEFTOVER_CONTAINER",
                `A container named "${reserved}" already exists, which means an earlier update or edit did not finish. Nothing was changed; inspect it from the Docker tab first.`
              );
            }
          }
        } catch (err) {
          return asError(reply, err);
        }

        // Missing host paths are created the way the Docker tab creates them,
        // owned by nobody:users, rather than left for docker to create as root.
        for (const path of hostPathsToCreate) {
          try {
            await ca.ensureHostDir(path);
          } catch (err) {
            return sendError(reply, 500, "TEMPLATE_HOST_PATH_FAILED", `Could not create ${path}: ${safe(err)}. The container was not touched.`);
          }
        }

        let backupPath: string | undefined;
        if (edited.changes.length > 0) {
          try {
            backupPath = await runtime.backupTemplate(tpl.path, runtime.now());
          } catch (err) {
            return sendError(reply, 500, "TEMPLATE_BACKUP_FAILED", `Could not back up ${tpl.path}: ${safe(err)}. Nothing was changed.`);
          }
        }

        // Build the replacement before the running app is touched. The command
        // is a shell string because that is what Unraid builds and runs: Extra
        // Parameters and Post Arguments are shell fragments by design.
        let candidateId: string;
        try {
          const create = await buildCommand(stagedPath, candidateName, extraVolumes, secrets);
          const { stdout } = await ca.run("/bin/bash", ["-c", create.command], PULL_TIMEOUT_MS);
          candidateId = stdout.trim().split("\n").pop()?.trim() ?? "";
          if (!/^[0-9a-f]{12,64}$/i.test(candidateId.replace(/^sha256:/, ""))) {
            throw new Error(`docker create returned no container id${candidateId ? ` (${candidateId})` : ""}`);
          }
        } catch (err) {
          return sendError(
            reply,
            500,
            "TEMPLATE_CREATE_FAILED",
            `Could not create the rebuilt container for "${containerName}": ${safe(err)}. The existing container and its template were left untouched. If a container named "${candidateName}" now exists, UnraidClaw did not remove it: check it from the Docker tab.`
          );
        }

        // From here on everything targets container ids, never names.

        const rollback = async (renamed: boolean): Promise<string[]> => {
          const problems: string[] = [];
          try {
            await ca.run("docker", ["rm", "-f", candidateId]);
          } catch (err) {
            problems.push(`the rebuilt container ${candidateId} could not be removed (${safe(err)})`);
          }
          if (renamed) {
            try {
              await ca.run("docker", ["rename", facts.id, containerName]);
            } catch (err) {
              problems.push(`the original container could not be renamed back from "${rollbackName}" (${safe(err)})`);
            }
          }
          if (wasRunning) {
            try {
              await ca.run("docker", ["start", facts.id]);
            } catch (err) {
              problems.push(`the original container could not be restarted (${safe(err)})`);
            }
          }
          try {
            const raw = await lifecycle.inspectJson("container", facts.id);
            if (raw === null) {
              problems.push(`the original container ${facts.id} no longer exists`);
            } else {
              const now = parseContainerFacts(raw);
              if (now.name !== containerName) problems.push(`the original container is named "${now.name}"`);
              if (wasRunning && !now.running && now.status !== "restarting") problems.push("the original container is not running and it was before");
              if (!wasRunning && now.running) problems.push("the original container is running and it was stopped before");
            }
          } catch (err) {
            problems.push(`the original container could not be checked (${safe(err)})`);
          }
          return problems;
        };

        const failed = async (code: string, what: string, renamed: boolean, logs?: string) => {
          const problems = await rollback(renamed);
          const details = logs ? { logs } : undefined;
          if (problems.length === 0) {
            return sendError(
              reply,
              500,
              code,
              `${what} "${containerName}" was put back as it was and ${wasRunning ? "is running again" : "is stopped, as it was before"}. Its template was not changed.`,
              details
            );
          }
          return sendError(
            reply,
            500,
            "TEMPLATE_EDIT_INCOMPLETE",
            `${what} Putting the original back did not fully succeed either: ${problems.join("; ")}. "${containerName}" needs attention on the Docker tab. Container id ${facts.id} holds the original app, and its template was not changed; nothing was deleted.`,
            { containerId: facts.id, candidateId, rollbackName, problems, ...(details ?? {}) }
          );
        };

        for (const network of extraNetworks) {
          try {
            await ca.run("docker", ["network", "connect", network, candidateId]);
          } catch (err) {
            return await failed("TEMPLATE_NETWORK_FAILED", `Could not connect the rebuilt container to the "${network}" network: ${safe(err)}.`, false);
          }
        }

        if (facts.running || facts.status === "restarting") {
          try {
            await ca.run("docker", ["stop", facts.id], STOP_TIMEOUT_MS);
          } catch (err) {
            return await failed("TEMPLATE_STOP_FAILED", `Could not stop "${containerName}": ${safe(err)}.`, false);
          }
        }
        try {
          await ca.run("docker", ["rename", facts.id, rollbackName]);
        } catch (err) {
          return await failed("TEMPLATE_EDIT_FAILED", `Could not rename the existing container out of the way: ${safe(err)}.`, false);
        }
        try {
          await ca.run("docker", ["rename", candidateId, containerName]);
        } catch (err) {
          return await failed("TEMPLATE_EDIT_FAILED", `Could not give the rebuilt container its name: ${safe(err)}.`, true);
        }

        const logsOf = async () => {
          try {
            const { stdout, stderr } = await ca.run("docker", ["logs", "--tail", LOG_TAIL, candidateId]);
            return redactSecrets(secrets, `${stdout}${stderr}`.trim());
          } catch {
            return undefined;
          }
        };

        if (wasRunning) {
          try {
            await ca.run("docker", ["start", candidateId]);
          } catch (err) {
            return await failed("TEMPLATE_START_FAILED", `The rebuilt container would not start: ${safe(err)}.`, true, await logsOf());
          }
          // A container that starts and exits a second later has not started.
          // Waiting a moment before checking is what catches an edit that
          // broke the app, while the original is still there to go back to.
          await runtime.wait(runtime.settleMs);
        }

        let finalFacts: ContainerFacts;
        try {
          const raw = await lifecycle.inspectJson("container", candidateId);
          if (raw === null) return await failed("TEMPLATE_EDIT_FAILED", "The rebuilt container disappeared right after it was created.", true);
          finalFacts = parseContainerFacts(raw);
        } catch (err) {
          return await failed("TEMPLATE_EDIT_FAILED", `The rebuilt container could not be checked: ${safe(err)}.`, true);
        }
        if (wasRunning && (!finalFacts.running || finalFacts.status === "restarting")) {
          return await failed(
            "TEMPLATE_START_FAILED",
            `The rebuilt container ${finalFacts.status === "restarting" ? "keeps restarting" : `stopped right after starting (${finalFacts.status})`}; its last log lines are in the error details.`,
            true,
            await logsOf()
          );
        }
        if (
          finalFacts.name !== containerName ||
          normalizeImage(finalFacts.image) !== normalizeImage(image) ||
          finalFacts.running !== wasRunning ||
          (pulledImageId !== undefined && finalFacts.imageId !== pulledImageId)
        ) {
          return await failed(
            "TEMPLATE_EDIT_FAILED",
            `The rebuilt container is not what was asked for (name "${finalFacts.name}", image ${finalFacts.image || "unknown"}, ${finalFacts.running ? "running" : "stopped"}).`,
            true
          );
        }

        // Only a rebuilt container that checks out gets its template saved, so
        // the template on flash always describes the container that is there.
        if (edited.changes.length > 0) {
          try {
            await runtime.writeTemplate(tpl.path, edited.xml);
          } catch (err) {
            return await failed("TEMPLATE_WRITE_FAILED", `The rebuilt container worked, but its template could not be saved: ${safe(err)}.`, true);
          }
        }

        try {
          await ca.run("docker", ["rm", facts.id]);
        } catch (err) {
          warnings.push(`The rebuilt app is in place, but the previous container could not be removed (${safe(err)}). It is still on the Docker tab as "${rollbackName}".`);
        }

        const response: TemplateEditResponse = {
          ...base,
          dryRun: false,
          containerId: finalFacts.id,
          ...(backupPath ? { backupPath } : {}),
          rebuilt: true,
          running: finalFacts.running,
          ...(pulledImageId !== undefined ? { pulled: true } : {}),
          previousImageId: facts.imageId,
          imageId: finalFacts.imageId,
          plan,
          warnings,
        };
        return reply.send({ ok: true, data: response });
      } finally {
        if (stagedPath !== null) await runtime.discardStaged(stagedPath).catch(() => undefined);
        lifecycle.release(containerName);
      }
    },
  });
}
