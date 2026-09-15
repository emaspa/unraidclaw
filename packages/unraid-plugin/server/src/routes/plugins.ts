// HTTP surface for Unraid plugin (.plg) management.
//
// Six endpoints, each gated on its own permission and each defaulting to off:
//
//   GET  /api/plugins                 plugins:read
//   GET  /api/plugins/:file           plugins:read
//   POST /api/plugins/install         plugins:create
//   POST /api/plugins/:file/check     plugins:update
//   POST /api/plugins/:file/update    plugins:update
//   POST /api/plugins/:file/remove    plugins:delete
//
// `check` is gated on plugins:update, not plugins:read, because it is not a
// read: it downloads a file from the internet and stages it where Unraid's
// plugin manager will offer to install it. See checkPlan() for the wording the
// API returns about that.
//
// Every request body is validated by hand before anything else looks at it.
// Fastify's ajv runs with coerceTypes and removeAdditional on, which would turn
// a mistyped `dryrun: true` into a real install and a `dryRun: "false"` into a
// dry run; neither is acceptable when the operation runs vendor code as root.
//
// Mutating handlers read the plugin twice. The preflight outside the lock
// produces the error messages and the plan; the authoritative read happens
// inside the lock, immediately before the plugin manager runs, because between
// those two moments another caller (or the Unraid web UI, or a nightly check)
// can replace the installed file or the staged one.

import type { FastifyInstance, FastifyReply } from "fastify";
import { Resource, Action } from "@unraidclaw/shared";
import { join } from "node:path";
import { requirePermission } from "../permissions.js";
import {
  INSTALL_TIMEOUT_MS,
  PluginError,
  REMOVE_TIMEOUT_MS,
  UPDATE_TIMEOUT_MS,
  assertInstallable,
  assertMutable,
  assertNotSelf,
  attr,
  checkPlan,
  createPluginsRuntime,
  detail,
  installPlan,
  isBuiltinName,
  isNewer,
  listInstalled,
  loadInstalled,
  normalizePluginFile,
  parsePlg,
  removePlan,
  sanitizeOutput,
  summarize,
  updatePlan,
  validatePluginUrlSyntax,
  withPluginLock,
  type PluginActionRequest,
  type PluginCheckResponse,
  type PluginInstallRequest,
  type PluginInstallResponse,
  type PluginRemoveResponse,
  type PluginUpdateResponse,
  type PluginsRuntime,
} from "../plugins.js";

const INSTALL_BODY_FIELDS = ["url", "dryRun"] as const;
const ACTION_BODY_FIELDS = ["dryRun"] as const;

function sendError(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>
) {
  return reply.status(status).send({ ok: false, error: { code, message, ...(details ? { details } : {}) } });
}

function fail(reply: FastifyReply, err: unknown) {
  if (err instanceof PluginError) {
    return sendError(reply, err.statusCode, err.code, err.message, err.details);
  }
  throw err;
}

function rejectUnknownFields(raw: unknown, allowed: readonly string[]): Record<string, unknown> {
  const bad = (message: string, details?: Record<string, unknown>): never => {
    throw new PluginError(message, "PLUGIN_INVALID_BODY", 400, details);
  };
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    bad("The request body must be a JSON object.");
  }
  const body = raw as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (allowed.includes(key)) continue;
    const near = allowed.find((f) => f.toLowerCase() === key.toLowerCase());
    bad(
      near
        ? `Unknown field "${key}". Did you mean "${near}"?`
        : `Unknown field "${key}". Allowed fields are: ${allowed.join(", ")}.`,
      { field: key, allowed: [...allowed] }
    );
  }
  if (body.dryRun !== undefined && typeof body.dryRun !== "boolean") {
    bad(`"dryRun" must be true or false, not ${JSON.stringify(body.dryRun)}.`, { field: "dryRun" });
  }
  return body;
}

export function parseInstallBody(raw: unknown): PluginInstallRequest {
  const body = rejectUnknownFields(raw, INSTALL_BODY_FIELDS);
  if (body.url === undefined) {
    throw new PluginError('"url" is required: the https URL of the .plg file to install.', "PLUGIN_INVALID_BODY", 400, {
      field: "url",
    });
  }
  if (typeof body.url !== "string") {
    throw new PluginError('"url" must be a string.', "PLUGIN_INVALID_BODY", 400, { field: "url" });
  }
  return { url: body.url, ...(body.dryRun === undefined ? {} : { dryRun: body.dryRun as boolean }) };
}

export function parseActionBody(raw: unknown): PluginActionRequest {
  return rejectUnknownFields(raw, ACTION_BODY_FIELDS) as PluginActionRequest;
}

export function registerPluginRoutes(
  app: FastifyInstance,
  runtime: PluginsRuntime = createPluginsRuntime()
): void {
  const rt = runtime;

  /**
   * The installed plugin as it is right now, checked for mutability. `action`
   * is given for the operations that run the plugin's own scripts, which
   * UnraidClaw refuses to do to itself; a check runs none, so it passes null.
   */
  async function loadMutable(file: string, action: "update" | "remove" | null) {
    const installed = await loadInstalled(rt, file);
    assertMutable(installed.summary);
    if (action) assertNotSelf(file, installed.summary.name, action);
    return installed;
  }

  // ── List ─────────────────────────────────────────────────────
  app.get("/api/plugins", {
    preHandler: requirePermission(Resource.PLUGINS, Action.READ),
    handler: async (_req, reply) => {
      try {
        return reply.send({ ok: true, data: await listInstalled(rt) });
      } catch (err) {
        return fail(reply, err);
      }
    },
  });

  // ── Details ──────────────────────────────────────────────────
  app.get<{ Params: { file: string } }>("/api/plugins/:file", {
    preHandler: requirePermission(Resource.PLUGINS, Action.READ),
    handler: async (req, reply) => {
      try {
        const file = normalizePluginFile(req.params.file);
        const { summary, parsed } = await loadInstalled(rt, file);
        return reply.send({ ok: true, data: detail(summary, parsed) });
      } catch (err) {
        return fail(reply, err);
      }
    },
  });

  // ── Install from an explicit URL ──────────────────────────────
  app.post<{ Body: PluginInstallRequest }>("/api/plugins/install", {
    preHandler: requirePermission(Resource.PLUGINS, Action.CREATE),
    handler: async (req, reply) => {
      try {
        const body = parseInstallBody(req.body);
        const target = validatePluginUrlSyntax(body.url);
        const file = target.file;
        // An OS plugin is refused on its file name alone, before any download,
        // because a fresh install has no registration to consult.
        if (isBuiltinName(file)) {
          throw new PluginError(
            `"${file}" is an Unraid OS plugin. UnraidClaw does not install OS plugins; use the Unraid web UI.`,
            "PLUGIN_PROTECTED",
            422,
            { file }
          );
        }
        assertNotSelf(file, null, "install");
        const stagingPath = join(rt.stagingDir, file);
        const plan = installPlan(file, target.url, stagingPath, rt.bootDir);

        if (body.dryRun === true) {
          // Nothing is resolved, fetched or written: the plan is what a real
          // call would do, not a report of anything already done.
          const preview: PluginInstallResponse = { dryRun: true, plan, url: target.url };
          return reply.send({ ok: true, data: preview });
        }

        const data = await withPluginLock(file, "install", async () => {
          if (await rt.readLink(join(rt.linkDir, file))) {
            throw new PluginError(
              `"${file}" is already installed. Check for an update and apply it instead of reinstalling.`,
              "PLUGIN_ALREADY_INSTALLED",
              409,
              { file }
            );
          }

          const { text, finalUrl } = await rt.fetchPlg(target.url);
          const parsed = parsePlg(text, "The downloaded plugin file");
          const { name, version } = assertInstallable(parsed, file, null, "The downloaded plugin file");
          // A plugin that calls itself unraidclaw would overwrite this service
          // whatever the URL's file name says.
          assertNotSelf(file, name, "install");

          // Written to a path we own, named after the validated basename. The
          // plugin manager takes it from here: it copies the file to
          // /boot/config/plugins and creates the registration symlink.
          await rt.writeStaged(stagingPath, text);
          let result;
          try {
            result = await rt.run(rt.pluginCmd, ["install", stagingPath], INSTALL_TIMEOUT_MS);
          } finally {
            await rt.removeStaged(stagingPath);
          }
          const output = sanitizeOutput(result.stdout, result.stderr);

          if (result.timedOut) {
            throw new PluginError(
              `The plugin manager did not finish installing "${file}" within ${Math.round(INSTALL_TIMEOUT_MS / 60000)} minutes. It may still be running, and its scripts may have already changed the system; check the plugin list before retrying.`,
              "PLUGIN_INSTALL_TIMEOUT",
              504,
              { file, output }
            );
          }

          // Exit 0 is not the install record. The symlink is, and it has to
          // point at the flash copy of this plugin and report this version.
          const installedPath = await rt.readLink(join(rt.linkDir, file));
          if (result.code !== 0 || !installedPath) {
            throw new PluginError(
              result.code !== 0
                ? `The plugin manager refused to install "${file}" (exit ${result.code}). Its scripts may have run before it stopped, so the system is not guaranteed untouched.`
                : `The plugin manager reported success for "${file}" but the plugin did not register itself in ${rt.linkDir}, so it is not installed.`,
              result.code !== 0 ? "PLUGIN_INSTALL_FAILED" : "PLUGIN_INSTALL_UNVERIFIED",
              500,
              { file, exitCode: result.code, output }
            );
          }

          const installedXml = await rt.readPlg(installedPath);
          const installed = installedXml
            ? summarize(file, installedPath, parsePlg(installedXml, `Plugin file ${installedPath}`), rt.bootDir)
            : undefined;
          const expectedPath = join(rt.bootDir, file);
          if (
            !installed ||
            installedPath !== expectedPath ||
            installed.name !== name ||
            installed.version !== version
          ) {
            throw new PluginError(
              `The plugin manager reported success for "${file}" but the registered plugin does not match what was installed (registered ${installed?.name ?? "nothing readable"} ${installed?.version ?? ""} at ${installedPath}).`,
              "PLUGIN_INSTALL_UNVERIFIED",
              500,
              { file, expected: { name, version, path: expectedPath }, output }
            );
          }

          const response: PluginInstallResponse = {
            dryRun: false,
            plan,
            url: finalUrl,
            registered: true,
            installed,
            output,
          };
          return response;
        });

        return reply.send({ ok: true, data });
      } catch (err) {
        return fail(reply, err);
      }
    },
  });

  // ── Check for an update ──────────────────────────────────────
  app.post<{ Params: { file: string }; Body: PluginActionRequest }>("/api/plugins/:file/check", {
    preHandler: requirePermission(Resource.PLUGINS, Action.UPDATE),
    handler: async (req, reply) => {
      try {
        const body = parseActionBody(req.body);
        const file = normalizePluginFile(req.params.file);
        const preflight = await loadMutable(file, null);

        if (!preflight.summary.pluginURL) {
          throw new PluginError(
            `"${file}" has no pluginURL attribute, so it cannot check for updates. Its author has to add one.`,
            "PLUGIN_NO_UPDATE_URL",
            422,
            { file }
          );
        }
        // The plugin manager would paste this URL into a shell command line.
        // We never do that, and we refuse to act on a URL that would be unsafe
        // if anything else did.
        const target = validatePluginUrlSyntax(preflight.summary.pluginURL, "pluginURL");
        const stagedPath = join(rt.stagedDir, file);
        const plan = checkPlan(file, target.url, stagedPath);

        if (body.dryRun === true) {
          const preview: PluginCheckResponse = {
            dryRun: true,
            plan,
            file,
            installedVersion: preflight.summary.version,
          };
          return reply.send({ ok: true, data: preview });
        }

        const data = await withPluginLock(file, "check", async () => {
          // Re-read under the lock: the installed file may have changed since
          // the preflight, and it is the current pluginURL we must download.
          const { summary } = await loadMutable(file, null);
          const current = summary.pluginURL
            ? validatePluginUrlSyntax(summary.pluginURL, "pluginURL")
            : (() => {
                throw new PluginError(
                  `"${file}" has no pluginURL attribute, so it cannot check for updates.`,
                  "PLUGIN_NO_UPDATE_URL",
                  422,
                  { file }
                );
              })();

          const { text } = await rt.fetchPlg(current.url);
          const parsed = parsePlg(text, "The downloaded plugin file");
          // Staging a file arms an install, so the downloaded document has to
          // survive the same checks an install would apply, including being
          // the same plugin that is installed here.
          const { version: latestVersion } = assertInstallable(
            parsed,
            file,
            summary.name,
            "The downloaded plugin file"
          );

          // Staged where `plugin update` looks for it, which is the whole point
          // of a check: it arms the update without performing it.
          await rt.writeStaged(stagedPath, text);

          const response: PluginCheckResponse = {
            dryRun: false,
            plan,
            file,
            installedVersion: summary.version,
            latestVersion,
            updateAvailable: isNewer(latestVersion, summary.version),
            output: sanitizeOutput(
              `Downloaded ${current.url}`,
              `Staged ${stagedPath} (version ${latestVersion}); installed version is ${summary.version || "unknown"}.`
            ),
          };
          return response;
        });

        return reply.send({ ok: true, data });
      } catch (err) {
        return fail(reply, err);
      }
    },
  });

  // ── Apply a staged update ────────────────────────────────────
  app.post<{ Params: { file: string }; Body: PluginActionRequest }>("/api/plugins/:file/update", {
    preHandler: requirePermission(Resource.PLUGINS, Action.UPDATE),
    handler: async (req, reply) => {
      try {
        const body = parseActionBody(req.body);
        const file = normalizePluginFile(req.params.file);
        const stagedPath = join(rt.stagedDir, file);

        /**
         * Everything that has to hold about the pair of documents before the
         * plugin manager is allowed to run. Called once for the preview and
         * again inside the lock against whatever the files say at that moment.
         */
        const resolveUpdate = async () => {
          const { summary } = await loadMutable(file, "update");
          const stagedXml = await rt.readPlg(stagedPath);
          if (stagedXml === null) {
            throw new PluginError(
              `No update is staged for "${file}". Check for updates first; the plugin manager installs from ${stagedPath}.`,
              "PLUGIN_UPDATE_NOT_STAGED",
              409,
              { file }
            );
          }
          const staged = parsePlg(stagedXml, `The staged file ${stagedPath}`);
          // The staged file is whatever is sitting in a world-writable
          // directory. It is re-checked here, not trusted because a check once
          // wrote there: same plugin, installable, and actually newer.
          const { version: stagedVersion } = assertInstallable(
            staged,
            file,
            summary.name,
            `The staged file ${stagedPath}`
          );
          if (stagedVersion === summary.version) {
            throw new PluginError(
              `"${file}" is already at version ${summary.version}; the staged file is the same version. The plugin manager refuses to reinstall it.`,
              "PLUGIN_ALREADY_CURRENT",
              409,
              { file, version: summary.version }
            );
          }
          if (!isNewer(stagedVersion, summary.version)) {
            throw new PluginError(
              `The staged file for "${file}" is version ${stagedVersion}, older than the installed ${summary.version}. UnraidClaw does not downgrade plugins.`,
              "PLUGIN_STAGED_OLDER",
              409,
              { file, stagedVersion, installedVersion: summary.version }
            );
          }
          return { summary, stagedVersion };
        };

        const preflight = await resolveUpdate();
        const plan = updatePlan(file, stagedPath, preflight.summary.version, preflight.stagedVersion);

        if (body.dryRun === true) {
          const preview: PluginUpdateResponse = {
            dryRun: true,
            plan,
            file,
            previousVersion: preflight.summary.version,
          };
          return reply.send({ ok: true, data: preview });
        }

        const data = await withPluginLock(file, "update", async () => {
          const { summary, stagedVersion } = await resolveUpdate();
          const result = await rt.run(rt.pluginCmd, ["update", file], UPDATE_TIMEOUT_MS);
          const output = sanitizeOutput(result.stdout, result.stderr);

          if (result.timedOut) {
            throw new PluginError(
              `The plugin manager did not finish updating "${file}" within ${Math.round(UPDATE_TIMEOUT_MS / 60000)} minutes. Check the plugin list before retrying.`,
              "PLUGIN_UPDATE_TIMEOUT",
              504,
              { file, output }
            );
          }
          if (result.code !== 0) {
            throw new PluginError(
              `The plugin manager could not update "${file}" (exit ${result.code}). It runs the new version's scripts before it reports a failure, so part of the update may already have been applied; read the output and check the plugin list.`,
              "PLUGIN_UPDATE_FAILED",
              500,
              { file, exitCode: result.code, output }
            );
          }

          // Exit 0 only says the script ran. Read the registration back.
          const path = await rt.readLink(join(rt.linkDir, file));
          const xml = path ? await rt.readPlg(path) : null;
          const after = xml ? parsePlg(xml, `Plugin file ${path}`) : null;
          const installedVersion = after ? attr(after, "version") : "";
          const installedName = after ? attr(after, "name") : "";
          const expectedPath = join(rt.bootDir, file);
          const verified =
            path === expectedPath && installedVersion === stagedVersion && installedName === summary.name;

          if (!verified) {
            throw new PluginError(
              !path
                ? `The plugin manager reported success but "${file}" is no longer registered in ${rt.linkDir}. The update left it uninstalled.`
                : `The plugin manager reported success but "${file}" now reads as ${installedName || "unnamed"} ${installedVersion || "unknown"} at ${path}, not ${summary.name} ${stagedVersion} at ${expectedPath}.`,
              "PLUGIN_UPDATE_UNVERIFIED",
              500,
              { file, expected: { name: summary.name, version: stagedVersion, path: expectedPath }, installedVersion, output }
            );
          }

          const response: PluginUpdateResponse = {
            dryRun: false,
            plan,
            file,
            previousVersion: summary.version,
            installedVersion,
            verified: true,
            output,
          };
          return response;
        });

        return reply.send({ ok: true, data });
      } catch (err) {
        return fail(reply, err);
      }
    },
  });

  // ── Remove ───────────────────────────────────────────────────
  app.post<{ Params: { file: string }; Body: PluginActionRequest }>("/api/plugins/:file/remove", {
    preHandler: requirePermission(Resource.PLUGINS, Action.DELETE),
    handler: async (req, reply) => {
      try {
        const body = parseActionBody(req.body);
        const file = normalizePluginFile(req.params.file);
        await loadMutable(file, "remove");

        const plan = removePlan(file, rt.bootDir);
        if (body.dryRun === true) {
          const preview: PluginRemoveResponse = { dryRun: true, plan, file };
          return reply.send({ ok: true, data: preview });
        }

        const data = await withPluginLock(file, "remove", async () => {
          // Re-checked under the lock: the plugin may have been replaced by an
          // OS-owned file, or removed entirely, since the preflight.
          await loadMutable(file, "remove");
          const result = await rt.run(rt.pluginCmd, ["remove", file], REMOVE_TIMEOUT_MS);
          const output = sanitizeOutput(result.stdout, result.stderr);

          if (result.timedOut) {
            throw new PluginError(
              `The plugin manager did not finish removing "${file}" within ${Math.round(REMOVE_TIMEOUT_MS / 60000)} minutes. Its removal script may have deleted part of the plugin already; check the plugin list before retrying.`,
              "PLUGIN_REMOVE_TIMEOUT",
              504,
              { file, output }
            );
          }
          if (result.code !== 0) {
            throw new PluginError(
              `The plugin manager could not remove "${file}" (exit ${result.code}). Its removal script failed partway, and the plugin manager restores the registration when that happens, so the plugin may be installed but incomplete.`,
              "PLUGIN_REMOVE_FAILED",
              500,
              { file, exitCode: result.code, output }
            );
          }

          const stillRegistered = Boolean(await rt.readLink(join(rt.linkDir, file)));
          const stillOnFlash = await rt.pathExists(join(rt.bootDir, file));
          if (stillRegistered || stillOnFlash) {
            throw new PluginError(
              `The plugin manager reported success but "${file}" is still ${stillRegistered ? `registered in ${rt.linkDir}` : `present in ${rt.bootDir}`}, so the removal did not complete.`,
              "PLUGIN_REMOVE_UNVERIFIED",
              500,
              { file, output }
            );
          }

          const response: PluginRemoveResponse = { dryRun: false, plan, file, removed: true, output };
          return response;
        });

        return reply.send({ ok: true, data });
      } catch (err) {
        return fail(reply, err);
      }
    },
  });
}
