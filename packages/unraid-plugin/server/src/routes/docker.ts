import type { FastifyInstance } from "fastify";
import { Resource, Action } from "@unraidclaw/shared";
import type { DockerContainer, DockerLogsResponse } from "@unraidclaw/shared";
import type { GraphQLClient } from "../graphql-client.js";
import { requirePermission } from "../permissions.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, mkdir } from "node:fs/promises";

const execFileAsync = promisify(execFile);

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Input validation for docker:create
const VALID_IMAGE_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:/@-]{0,254}$/;
const VALID_PORT_RE = /^\d{1,5}:\d{1,5}(\/(?:tcp|udp))?$/;
const VALID_VOLUME_RE = /^\/[^:]+:[^:]+(:(ro|rw))?$/;
const VALID_ENV_RE = /^[a-zA-Z_][a-zA-Z0-9_]*=.*/;
const VALID_NETWORK_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const VALID_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const VALID_RESTART_VALUES = new Set(["no", "always", "unless-stopped", "on-failure"]);

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

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

async function dockerInspect(id: string) {
  const { stdout } = await execFileAsync("docker", ["inspect", id]);
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

export function registerDockerRoutes(app: FastifyInstance, gql: GraphQLClient): void {
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
      try {
        const detail = await dockerInspect(req.params.id);
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
        const args = ["logs"];
        const tail = req.query.tail ?? "100";
        args.push("--tail", tail);
        if (req.query.since) args.push("--since", req.query.since);
        args.push(req.params.id);
        try {
          const { stdout, stderr } = await execFileAsync("docker", args);
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
        try {
          await execFileAsync("docker", [action, req.params.id]);
          const { stdout } = await execFileAsync("docker", [
            "inspect", "--format", '{{.Id}}\t{{.Name}}\t{{.State.Status}}', req.params.id,
          ]);
          const [id, name, state] = stdout.trim().split("\t");
          return reply.send({
            ok: true,
            data: { id, names: [name.replace(/^\//, "")], state, status: state },
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
      try {
        if (req.query.force === "true") {
          await execFileAsync("docker", ["rm", "-f", req.params.id]);
        } else {
          await execFileAsync("docker", ["rm", req.params.id]);
        }
        return reply.send({ ok: true, data: { id: req.params.id } });
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
      } = req.body;

      // Validate inputs
      if (!image || !VALID_IMAGE_RE.test(image)) {
        return reply.status(400).send({ ok: false, error: { code: "VALIDATION_ERROR", message: "Invalid image name" } });
      }
      if (name && !VALID_NAME_RE.test(name)) {
        return reply.status(400).send({ ok: false, error: { code: "VALIDATION_ERROR", message: "Invalid container name (alphanumeric, dots, dashes, underscores)" } });
      }
      if (restart && !VALID_RESTART_VALUES.has(restart)) {
        return reply.status(400).send({ ok: false, error: { code: "VALIDATION_ERROR", message: "Invalid restart policy" } });
      }
      if (network && !VALID_NETWORK_RE.test(network)) {
        return reply.status(400).send({ ok: false, error: { code: "VALIDATION_ERROR", message: "Invalid network name" } });
      }
      for (const p of ports) {
        if (!VALID_PORT_RE.test(p)) {
          return reply.status(400).send({ ok: false, error: { code: "VALIDATION_ERROR", message: `Invalid port mapping: ${p}` } });
        }
      }
      for (const v of volumes) {
        if (!VALID_VOLUME_RE.test(v)) {
          return reply.status(400).send({ ok: false, error: { code: "VALIDATION_ERROR", message: `Invalid volume mapping: ${v}` } });
        }
      }
      for (const e of env) {
        if (!VALID_ENV_RE.test(e)) {
          return reply.status(400).send({ ok: false, error: { code: "VALIDATION_ERROR", message: `Invalid env var format (expected KEY=VALUE): ${e.split("=")[0]}` } });
        }
      }

      const containerName = name ?? image.split("/").pop()?.split(":")[0] ?? "container";

      const args = ["run", "-d"];
      if (name) args.push("--name", name);
      if (restart) args.push("--restart", restart);
      if (network) args.push("--network", network);
      for (const p of ports) args.push("-p", p);
      for (const v of volumes) args.push("-v", v);
      for (const e of env) args.push("-e", e);

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
      args.push(image);

      // Pre-create host volume directories (only under /mnt/)
      for (const v of volumes) {
        const hostPath = v.split(":")[0];
        if (hostPath && hostPath.startsWith("/mnt/")) {
          await mkdir(hostPath, { recursive: true });
        }
      }

      try {
        const { stdout } = await execFileAsync("docker", args);
        const containerId = stdout.trim();

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
  <MyIP/>
  <Shell>sh</Shell>
  <Privileged>false</Privileged>
  <Support/>
  <Project/>
  <Overview>Deployed by UnraidClaw</Overview>
  <Category/>
  <WebUI>${escapeXml(webui ?? "")}</WebUI>
  <TemplateURL/>
  <Icon>${escapeXml(icon ?? "")}</Icon>
  <ExtraParams/>
  <PostArgs/>
  <CPUset/>
  <DateInstalled>${dateInstalled}</DateInstalled>
  <Requires/>
${portConfigs}
${volumeConfigs}
${envConfigs}
</Container>`;

        const safeContainerName = sanitizeFilename(containerName);
        const templatePath = `/boot/config/plugins/dockerMan/templates-user/my-${safeContainerName}.xml`;
        await writeFile(templatePath, xml, { encoding: "utf8", mode: 0o640 });

        return reply.send({ ok: true, data: { id: containerId, template: templatePath } });
      } catch (err: any) {
        return reply.status(500).send({
          ok: false,
          error: { code: "DOCKER_CREATE_FAILED", message: err.message },
        });
      }
    },
  });
}
