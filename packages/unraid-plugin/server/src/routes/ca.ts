import type { FastifyInstance, FastifyReply } from "fastify";
import { Resource, Action } from "@unraidclaw/shared";
import type {
  CaAppDetail,
  CaInstallRequest,
  CaInstallResponse,
  CaLifecycleRequest,
  CaRemoveResponse,
  CaSearchResponse,
  CaUpdatePlan,
  CaUpdateResponse,
} from "@unraidclaw/shared";
import { requirePermission } from "../permissions.js";
import { CaFeed, CaFeedError, findApps, searchCatalog, toSearchResult, type CaApp } from "../ca-feed.js";
import {
  CA_NAME_RE,
  CaInstallError,
  buildPlan,
  buildTemplateXml,
  computeBlockers,
  hostPaths,
  missingRequired,
  resolveOverrides,
  resolveTemplate,
  validateResolved,
  type TemplateEnv,
} from "../ca-template.js";
import {
  buildCreateArgs,
  containerBlockers,
  maskedValues,
  normalizeImage,
  parseContainerFacts,
  parseSavedTemplate,
  reconcileMounts,
  redactArgv,
  redactSecrets,
  type ContainerFacts,
  type SavedTemplate,
} from "../ca-saved-template.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir, writeFile, mkdir, chown, stat } from "node:fs/promises";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

export const TEMPLATES_DIR = "/boot/config/plugins/dockerMan/templates-user";
export const REBUILD_SCRIPT = "/usr/local/emhttp/plugins/dynamix.docker.manager/scripts/rebuild_container";

/** Building a container pulls an image, which can legitimately take a while. */
const REBUILD_TIMEOUT_MS = 15 * 60_000;
/** Plain docker queries should answer immediately. */
const DOCKER_TIMEOUT_MS = 60_000;
/** A pull is the same kind of wait as a build. */
const PULL_TIMEOUT_MS = 15 * 60_000;
/** Stopping honors the container's own grace period, which can be minutes. */
const STOP_TIMEOUT_MS = 5 * 60_000;

/** Where Unraid keeps the values it injects into every container it creates. */
export const VAR_INI = "/var/local/emhttp/var.ini";

/** Unraid's nobody:users, which every appdata directory is owned by. */
const APPDATA_UID = 99;
const APPDATA_GID = 100;

/**
 * Everything the install path touches outside its own process. Tests replace
 * these so the non-dry-run path is exercised end to end against a temp
 * directory and a recording runner, with nothing executed.
 */
export interface CaRuntime {
  feed: CaFeed;
  templatesDir: string;
  rebuildScript: string;
  /** Runs a program. Never a shell: argv only. Always bounded by a timeout. */
  run(file: string, args: string[], timeoutMs?: number): Promise<{ stdout: string; stderr: string }>;
  /** True when the path exists and is a directory. */
  directoryExists(path: string): Promise<boolean>;
  readUnraidVersion(): Promise<string | null>;
  listTemplateFiles(): Promise<string[]>;
  containerExists(name: string): Promise<boolean>;
  /** Creates the file, or throws EEXIST. The exclusive create is the install lock. */
  claimTemplate(path: string, xml: string): Promise<void>;
  /** Creates the directory if missing; leaves an existing directory untouched. */
  ensureHostDir(path: string): Promise<void>;
  /** Reads a saved template. Never writes one back: update and remove leave it byte-for-byte. */
  readTemplateFile(path: string): Promise<string>;
  /** Unraid's timezone and server name, which it injects into every container. */
  readHostVars(): Promise<{ timeZone: string | null; hostName: string | null }>;
}

/** `key="value"` lines, which is all var.ini is. */
function parseIni(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of raw.split("\n")) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*"?([^"\r\n]*)"?\s*$/.exec(line);
    if (m) out.set(m[1], m[2]);
  }
  return out;
}

export function createCaRuntime(overrides: Partial<CaRuntime> = {}): CaRuntime {
  const templatesDir = overrides.templatesDir ?? TEMPLATES_DIR;
  return {
    feed: overrides.feed ?? new CaFeed(),
    templatesDir,
    rebuildScript: overrides.rebuildScript ?? REBUILD_SCRIPT,
    run:
      overrides.run ??
      ((file, args, timeoutMs = DOCKER_TIMEOUT_MS) =>
        execFileAsync(file, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 })),
    directoryExists:
      overrides.directoryExists ??
      (async (path) => {
        try {
          return (await stat(path)).isDirectory();
        } catch {
          return false;
        }
      }),
    readUnraidVersion:
      overrides.readUnraidVersion ??
      (async () => {
        try {
          const raw = await readFile("/etc/unraid-version", "utf8");
          const m = /version\s*=\s*"?([\d.]+)/i.exec(raw);
          return m ? m[1] : raw.trim() || null;
        } catch {
          return null;
        }
      }),
    listTemplateFiles:
      overrides.listTemplateFiles ??
      (async () => {
        try {
          return await readdir(templatesDir);
        } catch {
          return [];
        }
      }),
    containerExists:
      overrides.containerExists ??
      (async (name) => {
        try {
          const { stdout } = await execFileAsync(
            "docker",
            ["ps", "-a", "--format", "{{.Names}}"],
            { timeout: DOCKER_TIMEOUT_MS }
          );
          return stdout.split("\n").some((n) => n.trim() === name);
        } catch {
          // If we cannot tell, assume it exists: refusing is recoverable,
          // clobbering someone's container is not.
          return true;
        }
      }),
    claimTemplate:
      overrides.claimTemplate ??
      (async (path, xml) => {
        await mkdir(templatesDir, { recursive: true });
        await writeFile(path, xml, { encoding: "utf8", mode: 0o640, flag: "wx" });
      }),
    ensureHostDir:
      overrides.ensureHostDir ??
      (async (path) => {
        // recursive:true returns the first directory it created, or undefined
        // when everything already existed. Every directory from that point
        // down to the leaf is new, and each one needs to belong to nobody:users
        // or the container (running as PUID 99) cannot write to it. Directories
        // that already existed are left alone.
        const created = await mkdir(path, { recursive: true, mode: 0o777 });
        if (!created) return;

        const tail = path.slice(created.length).split("/").filter(Boolean);
        let current = created;
        for (;;) {
          await chown(current, APPDATA_UID, APPDATA_GID);
          const next = tail.shift();
          if (next === undefined) break;
          current = join(current, next);
        }
      }),
    readTemplateFile: overrides.readTemplateFile ?? ((path) => readFile(path, "utf8")),
    readHostVars:
      overrides.readHostVars ??
      (async () => {
        try {
          const ini = parseIni(await readFile(VAR_INI, "utf8"));
          return { timeZone: ini.get("timeZone") || null, hostName: ini.get("NAME") || null };
        } catch {
          return { timeZone: null, hostName: null };
        }
      }),
  };
}

// Query strings are plain scalars, so a schema is enough for them. The install
// body gets a hand-written validator instead; see parseInstallBody.
const SEARCH_QUERY_SCHEMA = {
  type: "object",
  properties: {
    q: { type: "string" },
    limit: { type: "string", pattern: "^[0-9]{1,3}$" },
    includeDeprecated: { type: "string", enum: ["true", "false"] },
    includePlugins: { type: "string", enum: ["true", "false"] },
  },
} as const;

const REPO_QUERY_SCHEMA = {
  type: "object",
  properties: { repo: { type: "string", maxLength: 200 } },
} as const;

const INSTALL_BODY_FIELDS = ["repo", "name", "overrides", "dryRun"] as const;

/**
 * Validate the install body ourselves rather than through a JSON schema.
 *
 * Fastify's ajv runs with `coerceTypes` and `removeAdditional` on, which are
 * both unsafe here: a mistyped `dryrun: true` would be stripped and the caller
 * would get a real install where they asked for a preview, and `dryRun:
 * "false"` would be coerced rather than questioned. Anything unexpected is
 * refused instead, before the install path touches anything.
 */
export function parseInstallBody(raw: unknown): CaInstallRequest {
  const fail = (message: string, details?: Record<string, unknown>): never => {
    throw new CaInstallError(message, "CA_INVALID_BODY", 400, details);
  };

  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    fail("The request body must be a JSON object.");
  }
  const body = raw as Record<string, unknown>;

  for (const key of Object.keys(body)) {
    if ((INSTALL_BODY_FIELDS as readonly string[]).includes(key)) continue;
    const near = INSTALL_BODY_FIELDS.find((f) => f.toLowerCase() === key.toLowerCase());
    fail(
      near
        ? `Unknown field "${key}". Did you mean "${near}"?`
        : `Unknown field "${key}". Allowed fields are: ${INSTALL_BODY_FIELDS.join(", ")}.`,
      { field: key, allowed: [...INSTALL_BODY_FIELDS] }
    );
  }

  for (const key of ["repo", "name"] as const) {
    if (body[key] !== undefined && typeof body[key] !== "string") {
      fail(`"${key}" must be a string.`, { field: key });
    }
  }
  if (body.dryRun !== undefined && typeof body.dryRun !== "boolean") {
    fail(`"dryRun" must be true or false, not ${JSON.stringify(body.dryRun)}.`, { field: "dryRun" });
  }
  if (body.overrides !== undefined) {
    if (typeof body.overrides !== "object" || body.overrides === null || Array.isArray(body.overrides)) {
      fail('"overrides" must be an object mapping field names to string values.', { field: "overrides" });
    }
    for (const [k, v] of Object.entries(body.overrides as Record<string, unknown>)) {
      if (typeof v !== "string") {
        fail(`Override "${k}" must be a string, not ${JSON.stringify(v)}.`, { field: k });
      }
    }
  }

  return body as CaInstallRequest;
}

/**
 * The body of an update or a remove: a dry-run flag and nothing else.
 *
 * Hand-checked for the same reason the install body is. A caller who writes
 * `dryrun: true` and gets a real update of a running app has been badly served
 * by type coercion; here they get a 400 naming the typo.
 */
export function parseLifecycleBody(raw: unknown): CaLifecycleRequest {
  const fail = (message: string, details?: Record<string, unknown>): never => {
    throw new CaInstallError(message, "CA_INVALID_BODY", 400, details);
  };

  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    fail("The request body must be a JSON object.");
  }
  const body = raw as Record<string, unknown>;

  for (const key of Object.keys(body)) {
    if (key === "dryRun") continue;
    fail(
      key.toLowerCase() === "dryrun"
        ? `Unknown field "${key}". Did you mean "dryRun"?`
        : `Unknown field "${key}". The only allowed field is: dryRun.`,
      { field: key, allowed: ["dryRun"] }
    );
  }
  if (body.dryRun !== undefined && typeof body.dryRun !== "boolean") {
    fail(`"dryRun" must be true or false, not ${JSON.stringify(body.dryRun)}.`, { field: "dryRun" });
  }
  return body as CaLifecycleRequest;
}

function sendError(reply: FastifyReply, status: number, code: string, message: string, details?: Record<string, unknown>) {
  return reply.status(status).send({ ok: false, error: { code, message, ...(details ? { details } : {}) } });
}

function detailFor(app: CaApp, env: TemplateEnv): CaAppDetail {
  const blockers = computeBlockers(app, env);
  // Masked fields hold secrets; their defaults are never echoed back.
  const config = app.config.map((c) => (c.mask ? { ...c, default: "" } : c));
  return {
    ...toSearchResult(app, blockers.length === 0),
    registry: app.raw.Registry ?? "",
    support: app.raw.Support ?? "",
    project: app.raw.Project ?? "",
    webui: app.raw.WebUI ?? "",
    network: (app.raw.Network ?? "bridge").toLowerCase(),
    privileged: String(app.raw.Privileged ?? "").toLowerCase() === "true",
    requires: app.raw.Requires ?? "",
    config,
    ports: config.filter((c) => c.type === "Port"),
    paths: config.filter((c) => c.type === "Path"),
    variables: config.filter((c) => c.type === "Variable"),
    missingRequired: missingRequired(app.config, new Map()),
    blockers,
  };
}

export function registerCaRoutes(app: FastifyInstance, runtime: CaRuntime = createCaRuntime()): void {
  const { feed } = runtime;

  async function catalog() {
    return await feed.load();
  }

  // One lifecycle action at a time per container. Install already refuses to
  // clobber an existing template through an exclusive create, but that says
  // nothing about an update or a remove arriving while an install is midway
  // through its rebuild, so all three share this claim.
  const inFlight = new Map<string, string>();

  function claimLifecycle(name: string, action: string): void {
    const holder = inFlight.get(name);
    if (holder !== undefined) {
      throw new CaInstallError(
        `Another ${holder} of "${name}" is already running. Wait for it to finish.`,
        "CA_ACTION_IN_FLIGHT",
        409,
        { container: name, inFlight: holder }
      );
    }
    inFlight.set(name, action);
  }

  const releaseLifecycle = (name: string) => inFlight.delete(name);

  /**
   * `docker inspect` as JSON, or null when docker says there is no such object.
   *
   * Only that one answer becomes null. A daemon that is down, slow or broken
   * throws, because "docker could not tell me" is not "it is not there": read
   * as absence it would turn a timeout right after `docker rm` into a confirmed
   * removal, and would let a reserved name look free while a container sits on
   * it.
   */
  async function inspectJson(kind: "container" | "image", ref: string): Promise<string | null> {
    try {
      const args =
        kind === "container"
          ? ["inspect", "--type", "container", "--format", "{{json .}}", ref]
          : ["image", "inspect", "--format", "{{json .}}", ref];
      const { stdout } = await runtime.run("docker", args);
      const text = stdout.trim();
      return text === "" ? null : text;
    } catch (err) {
      const e = err as Error & { stderr?: string };
      if (/no such (?:container|image|object)/i.test(`${e.stderr ?? ""} ${e.message ?? ""}`)) return null;
      throw new CaInstallError(
        `docker could not be asked about "${ref}": ${e.message}`,
        "CA_DOCKER_UNAVAILABLE",
        503
      );
    }
  }

  /**
   * Resolve an installed app: its saved template and its live container, with
   * every identity check between them done before anything else happens.
   *
   * Fails closed on every mismatch. The name in the URL is the *installed
   * container's* name, never a catalog display name, and this is the only
   * place that decides which container an update or a remove is allowed to
   * touch.
   */
  async function loadInstalled(
    containerName: string
  ): Promise<{ tpl: SavedTemplate; facts: ContainerFacts; rawContainer: string }> {
    if (!CA_NAME_RE.test(containerName)) {
      throw new CaInstallError(
        `Container name ${JSON.stringify(containerName)} is not a valid Docker container name.`,
        "CA_INVALID_NAME",
        400
      );
    }

    const rawContainer = await inspectJson("container", containerName);
    if (rawContainer === null) {
      throw new CaInstallError(
        `No container named "${containerName}" exists on this server. This must be the installed container's name, which is not always the app's name in Community Applications; list your containers to find it.`,
        "CA_CONTAINER_NOT_FOUND",
        404
      );
    }
    const facts = parseContainerFacts(rawContainer);
    if (facts.name !== containerName) {
      throw new CaInstallError(
        `docker reports the container as "${facts.name}", not "${containerName}". Nothing was changed.`,
        "CA_CONTAINER_MISMATCH",
        409
      );
    }
    if (facts.labels["net.unraid.docker.managed"] !== "dockerman") {
      throw new CaInstallError(
        `"${containerName}" was not created by Unraid's docker manager, so UnraidClaw has no template describing it. Manage it from the Docker tab.`,
        "CA_NOT_MANAGED",
        409
      );
    }

    const files = await runtime.listTemplateFiles();
    const wanted = `my-${containerName}.xml`.toLowerCase();
    const matches = files.filter((f) => f.toLowerCase() === wanted);
    if (matches.length === 0) {
      throw new CaInstallError(
        `No saved template for "${containerName}" in ${runtime.templatesDir}, so UnraidClaw cannot tell how it was configured.`,
        "CA_TEMPLATE_NOT_FOUND",
        404
      );
    }
    if (matches.length > 1) {
      throw new CaInstallError(
        `${matches.length} saved templates match "${containerName}" (${matches.join(", ")}). Remove the duplicate before continuing.`,
        "CA_TEMPLATE_AMBIGUOUS",
        409,
        { candidates: matches }
      );
    }

    const path = join(runtime.templatesDir, matches[0]);
    let xml: string;
    try {
      xml = await runtime.readTemplateFile(path);
    } catch (err) {
      throw new CaInstallError(`Could not read ${path}: ${(err as Error).message}`, "CA_TEMPLATE_UNREADABLE", 500);
    }

    const tpl = parseSavedTemplate(xml, path);
    if (tpl.resolved.name !== containerName) {
      throw new CaInstallError(
        `${path} describes a container named "${tpl.resolved.name}", not "${containerName}". Nothing was changed.`,
        "CA_TEMPLATE_MISMATCH",
        409
      );
    }
    if (normalizeImage(tpl.resolved.image) !== normalizeImage(facts.image)) {
      throw new CaInstallError(
        `${path} is for the image "${tpl.resolved.image}", but "${containerName}" runs "${facts.image}". UnraidClaw will not act on a template that does not match the installed container.`,
        "CA_TEMPLATE_MISMATCH",
        409,
        { templateImage: tpl.resolved.image, containerImage: facts.image }
      );
    }

    return { tpl, facts, rawContainer };
  }

  // Search the catalog by name, image, maintainer or description.
  app.get<{ Querystring: { q?: string; limit?: string; includeDeprecated?: string; includePlugins?: string } }>(
    "/api/ca/search",
    {
      schema: { querystring: SEARCH_QUERY_SCHEMA },
      preHandler: requirePermission(Resource.CA, Action.READ),
      handler: async (req, reply) => {
        const q = (req.query.q ?? "").trim();
        if (!q) {
          return sendError(reply, 400, "VALIDATION_ERROR", "Query parameter 'q' is required.");
        }
        const limit = Math.min(Math.max(parseInt(req.query.limit ?? "25", 10) || 25, 1), 100);

        let cat;
        try {
          cat = await catalog();
        } catch (err) {
          const e = err as CaFeedError;
          return sendError(reply, 503, e.code ?? "CA_FEED_UNAVAILABLE", e.message);
        }

        const env: TemplateEnv = { unraidVersion: await runtime.readUnraidVersion() };
        const hits = searchCatalog(cat, q, {
          limit,
          includeDeprecated: req.query.includeDeprecated === "true",
          includePlugins: req.query.includePlugins === "true",
        });

        const response: CaSearchResponse = {
          query: q,
          total: hits.length,
          results: hits.map((a) => toSearchResult(a, computeBlockers(a, env).length === 0)),
          feedUpdated: cat.updated,
        };
        return reply.send({ ok: true, data: response });
      },
    }
  );

  // Full template for one app, including why it may not be installable.
  app.get<{ Params: { name: string }; Querystring: { repo?: string } }>("/api/ca/app/:name", {
    schema: { querystring: REPO_QUERY_SCHEMA },
    preHandler: requirePermission(Resource.CA, Action.READ),
    handler: async (req, reply) => {
      let cat;
      try {
        cat = await catalog();
      } catch (err) {
        const e = err as CaFeedError;
        return sendError(reply, 503, e.code ?? "CA_FEED_UNAVAILABLE", e.message);
      }

      const matches = findApps(cat, req.params.name, req.query.repo);
      if (matches.length === 0) {
        return sendError(reply, 404, "CA_APP_NOT_FOUND", `No Community Applications template named "${req.params.name}".`);
      }
      if (matches.length > 1) {
        return sendError(
          reply,
          409,
          "CA_AMBIGUOUS_APP",
          `${matches.length} templates are named "${req.params.name}". Add ?repo= to pick one.`,
          {
            candidates: matches.map((m) => ({ name: m.name, repo: m.repo, repository: m.repository })),
          }
        );
      }

      const env: TemplateEnv = { unraidVersion: await runtime.readUnraidVersion() };
      return reply.send({ ok: true, data: detailFor(matches[0], env) });
    },
  });

  // Install an app from its template.
  app.post<{ Params: { name: string }; Body: CaInstallRequest }>("/api/ca/app/:name/install", {
    preHandler: requirePermission(Resource.CA, Action.CREATE),
    handler: async (req, reply) => {
      let body: CaInstallRequest;
      try {
        body = parseInstallBody(req.body);
      } catch (err) {
        const e = err as CaInstallError;
        return sendError(reply, e.statusCode, e.code, e.message, e.details);
      }

      let cat;
      try {
        cat = await catalog();
      } catch (err) {
        const e = err as CaFeedError;
        return sendError(reply, 503, e.code ?? "CA_FEED_UNAVAILABLE", e.message);
      }

      const matches = findApps(cat, req.params.name, body.repo);
      if (matches.length === 0) {
        return sendError(reply, 404, "CA_APP_NOT_FOUND", `No Community Applications template named "${req.params.name}".`);
      }
      if (matches.length > 1) {
        return sendError(
          reply,
          409,
          "CA_AMBIGUOUS_APP",
          `${matches.length} templates are named "${req.params.name}". Set "repo" to pick one.`,
          { candidates: matches.map((m) => ({ name: m.name, repo: m.repo, repository: m.repository })) }
        );
      }
      const app_ = matches[0];

      const env: TemplateEnv = { unraidVersion: await runtime.readUnraidVersion() };
      const containerName = body.name ?? app_.name;

      // The name is interpolated unescaped into a shell string by Unraid's own
      // installer, so it is checked before anything else looks at it.
      if (!CA_NAME_RE.test(containerName)) {
        return sendError(
          reply,
          400,
          "CA_INVALID_NAME",
          `Container name ${JSON.stringify(containerName)} must be 1-63 characters of letters, digits, dot, dash or underscore, starting with a letter or digit.`
        );
      }

      // A caller-supplied name clears only the template's own unsafe-name
      // blocker; every other refusal still stands.
      const blockers = computeBlockers(app_, env).filter(
        (b) => !(b.code === "CA_UNSAFE_NAME" && body.name !== undefined)
      );
      if (blockers.length > 0) {
        return sendError(
          reply,
          422,
          "CA_NOT_INSTALLABLE",
          `"${app_.name}" cannot be installed through UnraidClaw: ${blockers.map((b) => b.message).join(" ")}`,
          { blockers }
        );
      }

      let plan;
      let resolved;
      try {
        const overrides = resolveOverrides(app_.config, body.overrides);

        const missing = missingRequired(app_.config, overrides);
        if (missing.length > 0) {
          throw new CaInstallError(
            `"${app_.name}" needs a value for: ${missing.join(", ")}. Pass them in "overrides".`,
            "CA_MISSING_REQUIRED",
            400,
            { missingRequired: missing }
          );
        }

        resolved = resolveTemplate(app_, containerName, overrides);
        validateResolved(resolved);
      } catch (err) {
        if (err instanceof CaInstallError) {
          return sendError(reply, err.statusCode, err.code, err.message, err.details);
        }
        throw err;
      }

      const templatePath = join(runtime.templatesDir, `my-${containerName}.xml`);
      const xml = buildTemplateXml(app_, resolved);
      plan = buildPlan(app_, resolved, templatePath, xml);

      const warnings: string[] = [];
      if ((app_.raw.Requires ?? "").trim() !== "") {
        warnings.push(`Template prerequisites from the maintainer: ${app_.raw.Requires}`);
      }
      if (resolved.network === "host") {
        warnings.push("This template uses host networking, so its ports are passed as environment variables rather than published.");
      }

      if (body.dryRun) {
        const response: CaInstallResponse = { dryRun: true, plan, warnings };
        return reply.send({ ok: true, data: response });
      }

      // From here the install writes things, so it takes the same per-container
      // claim update and remove take: an update that arrived now would read a
      // half-written template and rebuild from it.
      try {
        claimLifecycle(containerName, "install");
      } catch (err) {
        const e = err as CaInstallError;
        return sendError(reply, e.statusCode, e.code, e.message, e.details);
      }
      try {
      // Collision checks before anything is written. Unraid's rebuild_container
      // removes any container of this name before recreating it, so installing
      // over an existing name would silently destroy it.
      const existingTemplates = await runtime.listTemplateFiles();
      const wanted = `my-${containerName}.xml`.toLowerCase();
      if (existingTemplates.some((f) => f.toLowerCase() === wanted)) {
        return sendError(
          reply,
          409,
          "CA_TEMPLATE_EXISTS",
          `A template named "${containerName}" already exists at ${templatePath}. Pick a different "name" or remove it first.`
        );
      }
      if (await runtime.containerExists(containerName)) {
        return sendError(
          reply,
          409,
          "CA_CONTAINER_EXISTS",
          `A container named "${containerName}" already exists. Pick a different "name" or remove it first.`
        );
      }

      // A template default such as /mnt/cache/appdata is useless on a server
      // with no cache pool: mkdir -p would happily create /mnt/cache on the
      // RAM-backed rootfs and the app would write its data there, losing it on
      // reboot and filling memory. Unraid's own installer rewrites the path to
      // an existing pool; UnraidClaw refuses and asks for an explicit one.
      for (const path of hostPaths(resolved)) {
        const match = /^\/mnt\/([^/]+)/.exec(path);
        if (!match) continue;
        const root = `/mnt/${match[1]}`;
        if (!(await runtime.directoryExists(root))) {
          return sendError(
            reply,
            400,
            "CA_HOST_ROOT_MISSING",
            `The template wants to store data under ${path}, but this server has no ${root}. Pass an override pointing at a share or pool that exists.`,
            { path, missingRoot: root }
          );
        }
      }

      // Exclusive create doubles as the lock against a concurrent install of
      // the same app: the loser gets EEXIST and nothing is clobbered.
      try {
        await runtime.claimTemplate(templatePath, xml);
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === "EEXIST") {
          return sendError(
            reply,
            409,
            "CA_TEMPLATE_EXISTS",
            `A template named "${containerName}" was created concurrently. Nothing was changed.`
          );
        }
        return sendError(reply, 500, "CA_TEMPLATE_WRITE_FAILED", `Could not write ${templatePath}: ${e.message}`);
      }

      // rebuild_container does not create host paths for us.
      for (const path of hostPaths(resolved)) {
        try {
          await runtime.ensureHostDir(path);
        } catch (err) {
          return sendError(
            reply,
            500,
            "CA_HOST_PATH_FAILED",
            `Could not create host directory ${path}: ${(err as Error).message}. The template was kept at ${templatePath}.`
          );
        }
      }

      try {
        await runtime.run(runtime.rebuildScript, [containerName], REBUILD_TIMEOUT_MS);
      } catch (err) {
        return sendError(
          reply,
          500,
          "CA_INSTALL_FAILED",
          `Unraid could not create the container: ${(err as Error).message}. The template was kept at ${templatePath}, so you can retry or finish the install from the Docker tab.`
        );
      }

      // rebuild_container ignores the exit status of the docker command it
      // runs, so it reports success even when the image pull or the create
      // failed. Its exit code proves nothing; only the container does.
      let containerId: string;
      let running: boolean;
      try {
        const { stdout } = await runtime.run("docker", [
          "inspect", "--format", "{{.Id}}\t{{.State.Running}}", containerName,
        ]);
        const [id, state] = stdout.trim().split("\t");
        if (!id) throw new Error("docker inspect returned no container id");
        containerId = id;
        running = state === "true";
      } catch (err) {
        return sendError(
          reply,
          500,
          "CA_INSTALL_FAILED",
          `Unraid reported no error but no container named "${containerName}" exists, so the image pull or the container creation failed: ${(err as Error).message}. The template was kept at ${templatePath}, so you can retry or finish the install from the Docker tab.`
        );
      }

      // The container exists from here on. rebuild_container stops it again
      // unless its name is listed in /var/lib/docker/unraid-autostart, so a
      // fresh install lands stopped; an app that was just asked for should run.
      if (!running) {
        try {
          await runtime.run("docker", ["start", containerName]);
        } catch (err) {
          warnings.push(
            `The container was created but could not be started: ${(err as Error).message}. Start it from the Docker tab.`
          );
        }
      }

      const response: CaInstallResponse = { dryRun: false, plan, containerId, warnings };
      return reply.send({ ok: true, data: response });
      } finally {
        releaseLifecycle(containerName);
      }
    },
  });

  // Update an installed app to the newest image of the tag it already runs,
  // keeping the configuration saved in its template.
  app.post<{ Params: { name: string }; Body: CaLifecycleRequest }>("/api/ca/app/:name/update", {
    preHandler: requirePermission(Resource.CA, Action.UPDATE),
    handler: async (req, reply) => {
      const containerName = req.params.name;
      let body: CaLifecycleRequest;
      try {
        body = parseLifecycleBody(req.body);
      } catch (err) {
        const e = err as CaInstallError;
        return sendError(reply, e.statusCode, e.code, e.message, e.details);
      }

      try {
        claimLifecycle(containerName, "update");
      } catch (err) {
        const e = err as CaInstallError;
        return sendError(reply, e.statusCode, e.code, e.message, e.details);
      }

      try {
        let tpl: SavedTemplate;
        let facts: ContainerFacts;
        let rawContainer: string;
        try {
          ({ tpl, facts, rawContainer } = await loadInstalled(containerName));
        } catch (err) {
          if (err instanceof CaInstallError) {
            return sendError(reply, err.statusCode, err.code, err.message, err.details);
          }
          throw err;
        }

        // A template's masked fields are its passwords and API keys. They go to
        // docker, never into a response, a plan or an error message.
        const secrets = maskedValues(tpl);
        const safe = (err: unknown) => redactSecrets(secrets, String((err as Error)?.message ?? err));

        // A paused or restarting container has no state an update could put
        // back. Bringing a paused app back running would look like success and
        // be a change nobody asked for.
        if (facts.unstable) {
          return sendError(
            reply,
            409,
            "CA_UNSTABLE_STATE",
            `"${containerName}" is ${facts.status}. UnraidClaw updates a container that is running or stopped, so nothing was changed.`,
            { status: facts.status }
          );
        }

        let blockers;
        let mounts;
        try {
          // Compared against the image the container was created from, not the
          // one about to be pulled: a new image may legitimately change its own
          // defaults, and that is not a reason to refuse.
          const rawOldImage = await inspectJson("image", facts.imageId);
          mounts = reconcileMounts(tpl, facts.mounts);
          blockers = [
            ...tpl.blockers,
            ...containerBlockers(rawContainer, rawOldImage, tpl.resolved.network),
            ...mounts.blockers,
          ];
        } catch (err) {
          if (err instanceof CaInstallError) {
            return sendError(reply, err.statusCode, err.code, err.message, err.details);
          }
          throw err;
        }
        if (blockers.length > 0) {
          return sendError(
            reply,
            422,
            "CA_NOT_UPDATABLE",
            `"${containerName}" cannot be updated through UnraidClaw: ${blockers.map((b) => b.message).join(" ")}`,
            { blockers }
          );
        }
        try {
          validateResolved(tpl.resolved);
        } catch (err) {
          const e = err as CaInstallError;
          return sendError(reply, e.statusCode, e.code, redactSecrets(secrets, `${tpl.path}: ${e.message}`), e.details);
        }

        const hostVars = await runtime.readHostVars();
        const createOptions = {
          createName: containerName,
          timeZone: hostVars.timeZone,
          hostName: hostVars.hostName,
          restart: facts.restart,
          pidsLimit: facts.pidsLimit,
          extraVolumes: mounts.volumeArgs,
        };
        const plan: CaUpdatePlan = {
          name: containerName,
          templatePath: tpl.path,
          image: tpl.resolved.image,
          network: tpl.resolved.network,
          ports: redactArgv(secrets, tpl.resolved.ports),
          volumes: redactArgv(secrets, [...tpl.resolved.volumes, ...mounts.volumeArgs]),
          env: redactArgv(secrets, tpl.resolved.env),
          labels: redactArgv(secrets, tpl.labels),
          dockerCommand: redactArgv(secrets, ["docker", ...buildCreateArgs(tpl, createOptions)]),
        };

        const warnings: string[] = [];
        if (hostVars.timeZone === null) {
          warnings.push(
            `Unraid's timezone could not be read from ${VAR_INI}, so the rebuilt container gets no TZ variable and will run in UTC unless its template sets one.`
          );
        }
        if (mounts.volumeArgs.length > 0) {
          warnings.push(
            `Carrying over ${mounts.volumeArgs.length} volume(s) the container has that its template does not mention, so the app keeps the data in them.`
          );
        }

        const base = {
          name: containerName,
          containerId: facts.id,
          templatePath: tpl.path,
          image: tpl.resolved.image,
          previousImageId: facts.imageId,
          wasRunning: facts.running,
          plan,
        };

        if (body.dryRun) {
          const response: CaUpdateResponse = {
            ...base,
            dryRun: true,
            updated: false,
            running: facts.running,
            warnings,
          };
          return reply.send({ ok: true, data: response });
        }

        // Pull first and separately. A failed pull must leave the running app
        // exactly as it was, which is also why Unraid's own update script is
        // not used here: it deletes the previous image once the new one lands.
        try {
          await runtime.run("docker", ["pull", tpl.resolved.image], PULL_TIMEOUT_MS);
        } catch (err) {
          return sendError(
            reply,
            502,
            "CA_PULL_FAILED",
            `Could not pull ${tpl.resolved.image}: ${safe(err)}. "${containerName}" was left running exactly as it was and its image was not touched.`
          );
        }

        let newImageId = "";
        try {
          const rawNewImage = await inspectJson("image", tpl.resolved.image);
          newImageId = String(JSON.parse(rawNewImage ?? "null")?.Id ?? "");
        } catch (err) {
          if (err instanceof CaInstallError) {
            return sendError(reply, err.statusCode, err.code, err.message, err.details);
          }
          newImageId = "";
        }
        if (newImageId === "") {
          return sendError(
            reply,
            500,
            "CA_IMAGE_UNREADABLE",
            `docker pull reported success but ${tpl.resolved.image} cannot be inspected, so UnraidClaw will not recreate "${containerName}". Nothing was changed.`
          );
        }
        if (newImageId === facts.imageId) {
          const response: CaUpdateResponse = {
            ...base,
            dryRun: false,
            updated: false,
            imageId: newImageId,
            running: facts.running,
            warnings: [...warnings, `${tpl.resolved.image} is already the image "${containerName}" is running, so nothing was recreated.`],
          };
          return reply.send({ ok: true, data: response });
        }

        // Names used while the swap is in progress. Both must be free, or a
        // previous interrupted update is still lying around and a person should
        // look at it before anything else moves.
        const candidateName = `${containerName}.unraidclaw-new`;
        const rollbackName = `${containerName}.unraidclaw-old`;
        try {
          for (const reserved of [candidateName, rollbackName]) {
            if ((await inspectJson("container", reserved)) !== null) {
              return sendError(
                reply,
                409,
                "CA_LEFTOVER_CONTAINER",
                `A container named "${reserved}" already exists, which means an earlier update did not finish. Nothing was changed; inspect it from the Docker tab first.`
              );
            }
          }
        } catch (err) {
          if (err instanceof CaInstallError) {
            return sendError(reply, err.statusCode, err.code, err.message, err.details);
          }
          throw err;
        }

        // Build the replacement before the running app is touched.
        let candidateId: string;
        try {
          const { stdout } = await runtime.run(
            "docker",
            buildCreateArgs(tpl, { ...createOptions, createName: candidateName }),
            DOCKER_TIMEOUT_MS
          );
          candidateId = stdout.trim().split("\n").pop()?.trim() ?? "";
          if (candidateId === "") throw new Error("docker create returned no container id");
        } catch (err) {
          // Nothing has been renamed or stopped, so the app is untouched. No
          // cleanup by name: if that name is taken, it is taken by a container
          // this call did not create, and removing it would destroy someone
          // else's app. Leftovers are reported instead.
          return sendError(
            reply,
            500,
            "CA_CREATE_FAILED",
            `Could not create the replacement container for "${containerName}": ${safe(err)}. The existing container was left untouched${facts.running ? " and is still running" : ""}, and the new image was kept. If a container named "${candidateName}" now exists, UnraidClaw did not remove it: check it from the Docker tab.`
          );
        }

        // Everything from here targets container ids, never names: a rename
        // racing us from outside must not turn a rollback into the removal of
        // somebody else's container.

        /**
         * Put the original container back under its own name and state, then
         * check that it really is back. Every problem is collected rather than
         * swallowed, because a half-finished rollback reported as a clean one
         * is how an app goes missing.
         */
        const rollback = async (renamed: boolean): Promise<string[]> => {
          const problems: string[] = [];
          try {
            await runtime.run("docker", ["rm", "-f", candidateId]);
          } catch (err) {
            problems.push(`the replacement container ${candidateId} could not be removed (${safe(err)})`);
          }
          if (renamed) {
            try {
              await runtime.run("docker", ["rename", facts.id, containerName]);
            } catch (err) {
              problems.push(`the original container could not be renamed back from "${rollbackName}" (${safe(err)})`);
            }
          }
          if (facts.running) {
            try {
              await runtime.run("docker", ["start", facts.id]);
            } catch (err) {
              problems.push(`the original container could not be restarted (${safe(err)})`);
            }
          }
          try {
            const raw = await inspectJson("container", facts.id);
            if (raw === null) {
              problems.push(`the original container ${facts.id} no longer exists`);
            } else {
              const now = parseContainerFacts(raw);
              if (now.name !== containerName) problems.push(`the original container is named "${now.name}"`);
              if (now.running !== facts.running) {
                problems.push(
                  `the original container is ${now.running ? "running" : "not running"} and it was ${facts.running ? "running" : "stopped"} before`
                );
              }
            }
          } catch (err) {
            problems.push(`the original container could not be checked (${safe(err)})`);
          }
          return problems;
        };

        const failed = async (code: string, what: string, renamed: boolean) => {
          const problems = await rollback(renamed);
          if (problems.length === 0) {
            return sendError(
              reply,
              500,
              code,
              `${what} "${containerName}" was rolled back to its previous image and ${facts.running ? "is running again" : "is stopped, as it was before"}. The pulled image was kept and no data was removed.`
            );
          }
          return sendError(
            reply,
            500,
            "CA_UPDATE_INCOMPLETE",
            `${what} The rollback did not fully succeed either: ${problems.join("; ")}. "${containerName}" needs attention on the Docker tab. Container id ${facts.id} holds the original app; nothing was deleted.`,
            { containerId: facts.id, candidateId, rollbackName, problems }
          );
        };

        if (facts.running) {
          try {
            await runtime.run("docker", ["stop", facts.id], STOP_TIMEOUT_MS);
          } catch (err) {
            return await failed("CA_STOP_FAILED", `Could not stop "${containerName}": ${safe(err)}.`, false);
          }
        }

        try {
          await runtime.run("docker", ["rename", facts.id, rollbackName]);
        } catch (err) {
          return await failed("CA_UPDATE_FAILED", `Could not rename the existing container out of the way: ${safe(err)}.`, false);
        }
        try {
          await runtime.run("docker", ["rename", candidateId, containerName]);
        } catch (err) {
          return await failed("CA_UPDATE_FAILED", `Could not give the replacement container its name: ${safe(err)}.`, true);
        }

        if (facts.running) {
          try {
            await runtime.run("docker", ["start", candidateId]);
          } catch (err) {
            return await failed("CA_START_FAILED", `The replacement container would not start: ${safe(err)}.`, true);
          }
        }

        // The postcondition is read back from docker rather than inferred from
        // exit codes, and anything unreadable is treated as a failure.
        let finalFacts: ContainerFacts;
        try {
          const rawFinal = await inspectJson("container", candidateId);
          if (rawFinal === null) {
            return await failed("CA_UPDATE_FAILED", "The replacement container disappeared right after it was created.", true);
          }
          finalFacts = parseContainerFacts(rawFinal);
        } catch (err) {
          return await failed("CA_UPDATE_FAILED", `The replacement container could not be checked: ${safe(err)}.`, true);
        }
        if (finalFacts.name !== containerName || finalFacts.imageId !== newImageId || finalFacts.running !== facts.running) {
          return await failed(
            "CA_UPDATE_FAILED",
            `The replacement container is not what was asked for (name "${finalFacts.name}", image ${finalFacts.imageId || "unknown"}, ${finalFacts.running ? "running" : "stopped"}).`,
            true
          );
        }

        // Only now is the old container removed, and only the container: no
        // -v, so its volumes stay, and its image is never deleted.
        try {
          await runtime.run("docker", ["rm", facts.id]);
        } catch (err) {
          warnings.push(
            `The updated app is running, but the previous container could not be removed (${safe(err)}). It is still on the Docker tab as "${rollbackName}".`
          );
        }

        const response: CaUpdateResponse = {
          ...base,
          dryRun: false,
          updated: true,
          containerId: finalFacts.id,
          imageId: newImageId,
          running: finalFacts.running,
          warnings,
        };
        return reply.send({ ok: true, data: response });
      } finally {
        releaseLifecycle(containerName);
      }
    },
  });
  // Remove an installed app's container, and nothing else.
  app.post<{ Params: { name: string }; Body: CaLifecycleRequest }>("/api/ca/app/:name/remove", {
    preHandler: requirePermission(Resource.CA, Action.DELETE),
    handler: async (req, reply) => {
      const containerName = req.params.name;
      let body: CaLifecycleRequest;
      try {
        body = parseLifecycleBody(req.body);
      } catch (err) {
        const e = err as CaInstallError;
        return sendError(reply, e.statusCode, e.code, e.message, e.details);
      }

      try {
        claimLifecycle(containerName, "remove");
      } catch (err) {
        const e = err as CaInstallError;
        return sendError(reply, e.statusCode, e.code, e.message, e.details);
      }

      try {
        let tpl: SavedTemplate;
        let facts: ContainerFacts;
        try {
          ({ tpl, facts } = await loadInstalled(containerName));
        } catch (err) {
          if (err instanceof CaInstallError) {
            return sendError(reply, err.statusCode, err.code, err.message, err.details);
          }
          throw err;
        }

        // Removal can stop a paused container, but a container that is
        // restarting or dead is in no state to be acted on.
        if (["restarting", "removing", "dead"].includes(facts.status)) {
          return sendError(
            reply,
            409,
            "CA_UNSTABLE_STATE",
            `"${containerName}" is ${facts.status}. Nothing was removed.`,
            { status: facts.status }
          );
        }

        // Everything the removal deliberately leaves behind, reported so a
        // person can see that reinstalling will find its data where it was.
        const preserved = {
          templatePath: tpl.path,
          image: facts.image,
          imageId: facts.imageId,
          volumes: facts.volumes,
          hostPaths: facts.binds,
        };
        const base = { name: containerName, containerId: facts.id, preserved };

        if (body.dryRun) {
          const response: CaRemoveResponse = {
            ...base,
            dryRun: true,
            removed: false,
            running: facts.running,
            warnings: [],
          };
          return reply.send({ ok: true, data: response });
        }

        if (facts.running || facts.status === "paused") {
          try {
            await runtime.run("docker", ["stop", facts.id], STOP_TIMEOUT_MS);
          } catch (err) {
            return sendError(
              reply,
              500,
              "CA_STOP_FAILED",
              `Could not stop "${containerName}": ${(err as Error).message}. Nothing was removed.`
            );
          }
        }

        // Plain `docker rm`: no -f, and above all no -v, so named volumes
        // survive. The template, the image and every appdata directory are
        // never touched by this route.
        try {
          await runtime.run("docker", ["rm", facts.id]);
        } catch (err) {
          return sendError(
            reply,
            500,
            "CA_REMOVE_FAILED",
            `Could not remove "${containerName}": ${(err as Error).message}. The app was ${facts.running ? "stopped but is still present" : "left as it was"}.`
          );
        }

        // Confirmed gone, or not confirmed at all. A daemon that stops
        // answering right here must not be read as a successful removal.
        try {
          if ((await inspectJson("container", facts.id)) !== null) {
            return sendError(
              reply,
              500,
              "CA_REMOVE_FAILED",
              `docker reported no error but "${containerName}" still exists. Remove it from the Docker tab.`
            );
          }
        } catch (err) {
          const e = err as CaInstallError;
          return sendError(
            reply,
            500,
            "CA_REMOVE_UNVERIFIED",
            `docker accepted the removal of "${containerName}" but could not be asked whether it is gone: ${e.message}. Check the Docker tab. The template, image, volumes and appdata were not touched either way.`,
            { containerId: facts.id }
          );
        }

        const response: CaRemoveResponse = {
          ...base,
          dryRun: false,
          removed: true,
          running: false,
          warnings: [
            `The saved template was kept at ${tpl.path}, and the image, any Docker volumes and every appdata directory were left in place. Reinstalling from the Docker tab's Add Container will find this configuration again.`,
          ],
        };
        return reply.send({ ok: true, data: response });
      } finally {
        releaseLifecycle(containerName);
      }
    },
  });
}
