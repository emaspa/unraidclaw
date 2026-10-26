import type { FastifyInstance } from "fastify";
import { Resource, Action } from "@unraidclaw/shared";
import type { DockerContainer, DockerLogsResponse } from "@unraidclaw/shared";
import type { GraphQLClient } from "../graphql-client.js";
import { requirePermission } from "../permissions.js";
import { writeFile, mkdir } from "node:fs/promises";
import { isIP } from "node:net";
import {
  runCommand, validId, validBody, validInteger, type CommandRunner,
  escapeXml,
  sanitizeFilename,
  splitArgs,
  VALID_IMAGE_RE,
  VALID_PORT_RE,
  VALID_VOLUME_RE,
  VALID_ENV_RE,
  VALID_NETWORK_RE,
  VALID_NAME_RE,
  VALID_RESTART_VALUES,
  VALID_CPUSET_RE,
  validDevice,
  NETWORKS_WITHOUT_STATIC_IP,
} from "../docker-common.js";

interface DockerCreateBody {
  image: string;
  name?: string;
  ports?: string[];
  volumes?: string[];
  env?: string[];
  restart?: "no" | "always" | "unless-stopped" | "on-failure";
  network?: string;
  labels?: Record<string, string>;
  icon?: string;
  webui?: string;
  /** Unraid's Extra Parameters: docker run options, space separated. */
  extraArgs?: string;
  /** Unraid's Post Arguments: the container command, space separated. */
  postArgs?: string;
  /** Unraid's Fixed IP address, on a user-defined network only. */
  staticIp?: string;
  privileged?: boolean;
  /** Unraid's CPU pinning, as docker's --cpuset-cpus reads it. */
  cpuset?: string;
  /** Host devices, as docker's --device reads them. */
  devices?: string[];
}

const LIST_QUERY = `query {
  docker {
    containers {
      id
      names
      image
      state
      status
      autoStart
    }
  }
}`;

async function dockerInspect(id: string, run: CommandRunner) {
  const { stdout } = await run("docker", ["inspect", "--", id], { timeout: 15000 });
  const [info] = JSON.parse(stdout);
  return {
    id: info.Id,
    names: [info.Name.replace(/^\//, "")],
    image: info.Config.Image,
    state: info.State.Status,
    status: info.State.Status,
    autoStart: info.HostConfig?.RestartPolicy?.Name !== "no",
    ports: Object.entries(info.NetworkSettings?.Ports || {}).flatMap(
      ([containerPort, bindings]: [string, any]) => {
        const [port, proto] = containerPort.split("/");
        return (bindings || []).map((b: any) => ({
          ip: b.HostIp || "0.0.0.0",
          privatePort: parseInt(port),
          publicPort: parseInt(b.HostPort),
          type: proto,
        }));
      }
    ),
    mounts: (info.Mounts || []).map((m: any) => ({
      source: m.Source,
      destination: m.Destination,
      mode: m.Mode,
    })),
    networkMode: info.HostConfig?.NetworkMode ?? "",
  };
}

export function registerDockerRoutes(app: FastifyInstance, gql: GraphQLClient, options: {
  run?: CommandRunner;
  templatesDir?: string;
  mkdir?: typeof mkdir;
} = {}): void {
  const run = options.run ?? runCommand;
  const makeDirectory = options.mkdir ?? mkdir;
  // List containers
  app.get("/api/docker/containers", {
    preHandler: requirePermission(Resource.DOCKER, Action.READ),
    handler: async (_req, reply) => {
      const data = await gql.query<{ docker: { containers: DockerContainer[] } }>(LIST_QUERY);
      return reply.send({ ok: true, data: data.docker.containers });
    },
  });

  // Get container details via docker inspect CLI
  app.get<{ Params: { id: string } }>("/api/docker/containers/:id", {
    preHandler: requirePermission(Resource.DOCKER, Action.READ),
    handler: async (req, reply) => {
      if (!validId(req.params.id)) {
        return reply.status(400).send({ ok: false, error: { code: "VALIDATION_ERROR", message: "Invalid container ID" } });
      }
      try {
        const detail = await dockerInspect(req.params.id, run);
        return reply.send({ ok: true, data: detail });
      } catch (err: any) {
        return reply.status(404).send({
          ok: false,
          error: { code: "NOT_FOUND", message: err.message },
        });
      }
    },
  });

  // Get container logs via docker logs CLI
  app.get<{ Params: { id: string }; Querystring: { tail?: string; since?: string } }>(
    "/api/docker/containers/:id/logs",
    {
      preHandler: requirePermission(Resource.DOCKER, Action.READ),
      handler: async (req, reply) => {
        if (!validId(req.params.id)) {
          return reply.status(400).send({ ok: false, error: { code: "VALIDATION_ERROR", message: "Invalid container ID" } });
        }
        const args = ["logs"];
        const tail = req.query.tail ?? "100";
        if (!(tail === "all" || (validInteger(tail, 10000) && Number(tail) > 0))
          || (req.query.since !== undefined && (typeof req.query.since !== "string" || !req.query.since.length || req.query.since.length > 128 || /^-|[\x00-\x1f\x7f]/.test(req.query.since)))) {
          return reply.status(400).send({ ok: false, error: { code: "VALIDATION_ERROR", message: "Invalid logs tail or since" } });
        }
        args.push("--tail", tail);
        if (req.query.since) args.push("--since", req.query.since);
        args.push("--", req.params.id);
        try {
          const { stdout, stderr } = await run("docker", args, { timeout: 120000 });
          const response: DockerLogsResponse = { id: req.params.id, logs: stdout + stderr };
          return reply.send({ ok: true, data: response });
        } catch (err: any) {
          return reply.status(400).send({
            ok: false,
            error: { code: "DOCKER_LOGS_FAILED", message: err.message },
          });
        }
      },
    }
  );

  // Container actions via docker CLI: start, stop, restart, pause, unpause
  for (const action of ["start", "stop", "restart", "pause", "unpause"] as const) {
    app.post<{ Params: { id: string } }>(`/api/docker/containers/:id/${action}`, {
      preHandler: requirePermission(Resource.DOCKER, Action.UPDATE),
      handler: async (req, reply) => {
        if (!validId(req.params.id)) {
          return reply.status(400).send({ ok: false, error: { code: "VALIDATION_ERROR", message: "Invalid container ID" } });
        }
        try {
          await run("docker", [action, "--", req.params.id], { timeout: 120000 });
          const { stdout } = await run("docker", [
            "inspect", "--format", '{{.Id}}\t{{.Name}}\t{{.State.Status}}', "--", req.params.id,
          ], { timeout: 15000 });
          const [id, name, state] = stdout.trim().split("\t");
          const expected = action === "stop" ? "exited" : action === "pause" ? "paused" : "running";
          if (!id || !name || state !== expected) {
            return reply.status(500).send({ ok: false, error: { code: "VERIFICATION_FAILED", message: `Container did not reach ${expected}` }, data: { state, verified: false } });
          }
          return reply.send({
            ok: true,
            data: { id, names: [name.replace(/^\//, "")], state, status: state, verified: true },
          });
        } catch (err: any) {
          return reply.status(400).send({
            ok: false,
            error: { code: "DOCKER_ACTION_FAILED", message: err.message },
          });
        }
      },
    });
  }

  // Remove container (destructive)
  app.delete<{ Params: { id: string }; Querystring: { force?: string } }>("/api/docker/containers/:id", {
    preHandler: requirePermission(Resource.DOCKER, Action.DELETE),
    handler: async (req, reply) => {
      if (!validId(req.params.id)) {
        return reply.status(400).send({ ok: false, error: { code: "VALIDATION_ERROR", message: "Invalid container ID" } });
      }
      if (req.query.force !== undefined && req.query.force !== "true" && req.query.force !== "false") {
        return reply.status(400).send({ ok: false, error: { code: "VALIDATION_ERROR", message: "force must be true or false" } });
      }
      try {
        if (req.query.force === "true") {
          await run("docker", ["rm", "-f", "--", req.params.id], { timeout: 120000 });
        } else {
          await run("docker", ["rm", "--", req.params.id], { timeout: 120000 });
        }
        const { stdout } = await run("docker", ["ps", "-a", "--no-trunc", "--format", "{{.ID}}\t{{.Names}}"], { timeout: 15000 });
        if (stdout.trim().split("\n").some((line) => {
          const [id, name] = line.split("\t");
          return name === req.params.id || (/^[a-f0-9]{12,64}$/.test(req.params.id) && id.startsWith(req.params.id));
        })) {
          return reply.status(500).send({ ok: false, error: { code: "VERIFICATION_FAILED", message: "Container still exists" }, data: { verified: false } });
        }
        return reply.send({ ok: true, data: { id: req.params.id, verified: true } });
      } catch (err: any) {
        return reply.status(400).send({
          ok: false,
          error: { code: "DOCKER_REMOVE_FAILED", message: err.message },
        });
      }
    },
  });

  // Create container
  app.post<{ Body: DockerCreateBody }>("/api/docker/containers", {
    preHandler: requirePermission(Resource.DOCKER, Action.CREATE),
    handler: async (req, reply) => {
      const body = req.body;
      if (!validBody(body, ["image", "name", "ports", "volumes", "env", "restart", "network", "labels", "icon", "webui",
        "extraArgs", "postArgs", "staticIp", "privileged", "cpuset", "devices"])
        || typeof body.image !== "string"
        || ["name", "restart", "network", "icon", "webui", "extraArgs", "postArgs", "staticIp", "cpuset"].some((key) => body[key] !== undefined && typeof body[key] !== "string")
        || ["ports", "volumes", "env", "devices"].some((key) => body[key] !== undefined && (!Array.isArray(body[key]) || !(body[key] as unknown[]).every((v) => typeof v === "string")))
        || (body.privileged !== undefined && typeof body.privileged !== "boolean")
        || (body.labels !== undefined && (!validBody(body.labels, Object.keys(body.labels ?? {})) || Object.entries(body.labels).some(([key, value]) => !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/.test(key) || typeof value !== "string")))) {
        return reply.status(400).send({ ok: false, error: { code: "VALIDATION_ERROR", message: "Invalid container fields or types" } });
      }
      const {
        image,
        name,
        ports = [],
        volumes = [],
        env = [],
        restart = "unless-stopped",
        network = "bridge",
        labels = {},
        icon,
        webui,
        extraArgs,
        postArgs,
        staticIp,
        privileged = false,
        cpuset,
        devices = [],
      } = req.body;

      // Validate inputs
      if (!image || !VALID_IMAGE_RE.test(image)) {
        return reply.status(400).send({ ok: false, error: { code: "VALIDATION_ERROR", message: "Invalid image name" } });
      }
      if (name !== undefined && !VALID_NAME_RE.test(name)) {
        return reply.status(400).send({ ok: false, error: { code: "VALIDATION_ERROR", message: "Invalid container name (alphanumeric, dots, dashes, underscores)" } });
      }
      if (!VALID_RESTART_VALUES.has(restart)) {
        return reply.status(400).send({ ok: false, error: { code: "VALIDATION_ERROR", message: "Invalid restart policy" } });
      }
      if (!VALID_NETWORK_RE.test(network)) {
        return reply.status(400).send({ ok: false, error: { code: "VALIDATION_ERROR", message: "Invalid network name" } });
      }
      for (const p of ports) {
        if (!VALID_PORT_RE.test(p)) {
          return reply.status(400).send({ ok: false, error: { code: "VALIDATION_ERROR", message: `Invalid port mapping: ${p}` } });
        }
      }
      for (const v of volumes) {
        if (!VALID_VOLUME_RE.test(v) || v.split(":")[0].split("/").includes("..")) {
          return reply.status(400).send({ ok: false, error: { code: "VALIDATION_ERROR", message: `Invalid volume mapping: ${v}` } });
        }
      }
      for (const e of env) {
        if (!VALID_ENV_RE.test(e)) {
          return reply.status(400).send({ ok: false, error: { code: "VALIDATION_ERROR", message: `Invalid env var format (expected KEY=VALUE): ${e.split("=")[0]}` } });
        }
      }
      for (const d of devices) {
        if (!validDevice(d)) {
          return reply.status(400).send({ ok: false, error: { code: "VALIDATION_ERROR", message: `Invalid device (expected /dev/<host>[:/<container>][:rwm]): ${d}` } });
        }
      }
      if (cpuset !== undefined && !VALID_CPUSET_RE.test(cpuset)) {
        return reply.status(400).send({ ok: false, error: { code: "VALIDATION_ERROR", message: "Invalid cpuset (expected CPU numbers and ranges such as 0-3,8)" } });
      }
      // isIP also accepts a zone-scoped IPv6 address such as fe80::1%eth0,
      // which docker does not, so the alphabet is checked as well.
      const ipVersion = staticIp === undefined || !/^[0-9a-fA-F:.]+$/.test(staticIp) ? 0 : isIP(staticIp);
      if (staticIp !== undefined && ipVersion === 0) {
        return reply.status(400).send({ ok: false, error: { code: "VALIDATION_ERROR", message: "Invalid staticIp (expected an IPv4 or IPv6 address)" } });
      }
      if (staticIp !== undefined && NETWORKS_WITHOUT_STATIC_IP.has(network.toLowerCase())) {
        return reply.status(400).send({ ok: false, error: { code: "VALIDATION_ERROR", message: `staticIp needs a user-defined network such as a macvlan, ipvlan or custom bridge, not ${network}` } });
      }
      // Both free-form fields are checked here, before any command runs, and
      // the same text is written to the template, where Unraid later passes it
      // to the shell unescaped. splitArgs accepts nothing the shell could act on.
      const extraTokens = extraArgs === undefined ? [] : splitArgs(extraArgs);
      if (extraTokens === null || (extraTokens.length > 0 && !extraTokens[0].startsWith("-"))) {
        return reply.status(400).send({ ok: false, error: { code: "VALIDATION_ERROR", message: "Invalid extraArgs (expected docker run options separated by single spaces, using only letters, digits and : . , / + = _ -)" } });
      }
      const postTokens = postArgs === undefined ? [] : splitArgs(postArgs);
      if (postTokens === null) {
        return reply.status(400).send({ ok: false, error: { code: "VALIDATION_ERROR", message: "Invalid postArgs (expected command arguments separated by single spaces, using only letters, digits and : . , / + = _ -)" } });
      }

      const containerName = name ?? image.split("/").pop()?.split(":")[0] ?? "container";

      // The same order as Unraid's own command builder, so a container built
      // here matches one the Docker tab would build from the saved template.
      const args = ["run", "-d"];
      if (name) args.push("--name", name);
      if (restart) args.push("--restart", restart);
      if (network) args.push("--network", network);
      if (staticIp) args.push(ipVersion === 6 ? "--ip6" : "--ip", staticIp);
      if (cpuset) args.push("--cpuset-cpus", cpuset);
      if (privileged) args.push("--privileged=true");
      for (const p of ports) args.push("-p", p);
      for (const v of volumes) args.push("-v", v);
      for (const e of env) args.push("-e", e);
      for (const d of devices) args.push("--device", d);

      // Add Unraid managed labels so container appears as first-class citizen in UI
      const allLabels: Record<string, string> = {
        "net.unraid.docker.managed": "dockerman",
      };
      if (icon) allLabels["net.unraid.docker.icon"] = icon;
      if (webui) allLabels["net.unraid.docker.webui"] = webui;
      for (const [k, v] of Object.entries(labels)) allLabels[k] = v;
      for (const [k, v] of Object.entries(allLabels)) {
        args.push("--label", `${k}=${v}`);
      }
      args.push(...extraTokens, "--", image, ...postTokens);

      // Pre-create host volume directories (only under /mnt/)
      for (const v of volumes) {
        const hostPath = v.split(":")[0];
        if (hostPath && hostPath.startsWith("/mnt/")) {
          await makeDirectory(hostPath, { recursive: true });
        }
      }

      try {
        const { stdout } = await run("docker", args, { timeout: 120000 });
        const containerId = stdout.trim();
        if (!validId(containerId)) throw new Error("Invalid created container ID");

        // Build Unraid XML template
        const [repo] = image.split(":");
        const registry = repo.includes("/") && !repo.includes(".")
          ? `https://hub.docker.com/r/${repo}`
          : "";
        const dateInstalled = Math.floor(Date.now() / 1000);

        const portConfigs = ports.map((p) => {
          const [host, container] = p.split(":");
          const proto = container.includes("/udp") ? "udp" : "tcp";
          const containerPort = container.replace("/udp", "").replace("/tcp", "");
          return `  <Config Name="Port ${escapeXml(containerPort)}/${proto}" Target="${escapeXml(containerPort)}" Default="${escapeXml(host)}" Mode="${proto}" Description="" Type="Port" Display="always" Required="false" Mask="false">${escapeXml(host)}</Config>`;
        }).join("\n");

        const volumeConfigs = volumes.map((v) => {
          const [host, container] = v.split(":");
          const mode = v.split(":")[2] ?? "rw";
          return `  <Config Name="${escapeXml(container)}" Target="${escapeXml(container)}" Default="" Mode="${escapeXml(mode)}" Description="" Type="Path" Display="always" Required="false" Mask="false">${escapeXml(host)}</Config>`;
        }).join("\n");

        const deviceConfigs = devices.map((d) => {
          // Unraid reads the whole value back as the --device argument and
          // ignores Target for devices, so the value carries the full mapping.
          return `  <Config Name="Device ${escapeXml(d.split(":")[0])}" Target="" Default="" Mode="" Description="" Type="Device" Display="always" Required="false" Mask="false">${escapeXml(d)}</Config>`;
        }).join("\n");

        const envConfigs = env.map((e) => {
          const [key, ...rest] = e.split("=");
          const val = rest.join("=");
          const masked = key.toLowerCase().includes("secret") ||
            key.toLowerCase().includes("password") ||
            key.toLowerCase().includes("key");
          return `  <Config Name="${escapeXml(key)}" Target="${escapeXml(key)}" Default="" Mode="" Description="" Type="Variable" Display="always" Required="false" Mask="${masked}">${escapeXml(val)}</Config>`;
        }).join("\n");

        const xml = `<?xml version="1.0"?>
<Container version="2">
  <Name>${escapeXml(containerName)}</Name>
  <Repository>${escapeXml(image)}</Repository>
  <Registry>${escapeXml(registry)}</Registry>
  <Network>${escapeXml(network)}</Network>
  <MyIP>${escapeXml(staticIp ?? "")}</MyIP>
  <Shell>sh</Shell>
  <Privileged>${privileged ? "true" : "false"}</Privileged>
  <Support/>
  <Project/>
  <Overview>Deployed by UnraidClaw</Overview>
  <Category/>
  <WebUI>${escapeXml(webui ?? "")}</WebUI>
  <TemplateURL/>
  <Icon>${escapeXml(icon ?? "")}</Icon>
  <ExtraParams>${escapeXml(extraArgs ?? "")}</ExtraParams>
  <PostArgs>${escapeXml(postArgs ?? "")}</PostArgs>
  <CPUset>${escapeXml(cpuset ?? "")}</CPUset>
  <DateInstalled>${dateInstalled}</DateInstalled>
  <Requires/>
${portConfigs}
${volumeConfigs}
${envConfigs}
${deviceConfigs}
</Container>`;

        const safeContainerName = sanitizeFilename(containerName);
        const templatePath = `${options.templatesDir ?? "/boot/config/plugins/dockerMan/templates-user"}/my-${safeContainerName}.xml`;
        await writeFile(templatePath, xml, { encoding: "utf8", mode: 0o640 });

        // The container exists once docker run returns, so its template is saved
        // before the state check; otherwise a container that exits at once would
        // be left without one.
        const detail = await dockerInspect(containerId, run);
        if (detail.state !== "running") {
          return reply.status(500).send({ ok: false, error: { code: "VERIFICATION_FAILED", message: `Created container is ${detail.state}, not running` }, data: { id: containerId, template: templatePath, state: detail.state, verified: false } });
        }
        return reply.send({ ok: true, data: { id: containerId, template: templatePath, verified: true } });
      } catch (err: any) {
        // The error message repeats the docker run command line, including
        // environment values, so report only docker's own stderr.
        const detail = typeof err?.stderr === "string" ? err.stderr.trim().split("\n").slice(-3).join(" ").slice(0, 500) : "";
        return reply.status(500).send({
          ok: false,
          error: { code: "DOCKER_CREATE_FAILED", message: detail ? `Failed to create container: ${detail}` : "Failed to create container or save its template" },
        });
      }
    },
  });
}
