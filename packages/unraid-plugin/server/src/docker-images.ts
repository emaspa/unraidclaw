// Docker image housekeeping and container update status.
//
// Images are listed with the docker CLI and joined with every container,
// running or stopped, so an image is only called unused when no container
// references it. Pruning removes exactly the images it computed, one docker rmi
// per image, never `docker image prune`, and re-lists afterward to verify.
//
// Update status is read from Unraid's own cache, which the Docker tab's
// "check for updates" and the scheduled update check write. Nothing here talks
// to a registry or pulls an image.

import { readFile, stat } from "node:fs/promises";
import type {
  DockerImageInfo,
  DockerImagesResponse,
  DockerImagePruneMode,
  DockerImagePruneResponse,
  DockerUpdateStatusEntry,
  DockerUpdateStatusResponse,
} from "@unraidclaw/shared";
import type { CommandRunner } from "./docker-common.js";

export const UPDATE_STATUS_PATH = "/var/lib/docker/unraid-update-status.json";
/** The cache is a few KB per image. Anything far larger is not the real file. */
const MAX_UPDATE_STATUS_BYTES = 8 * 1024 * 1024;
const LIST_TIMEOUT_MS = 30000;
const RMI_TIMEOUT_MS = 120000;
const MAX_BUFFER = 32 * 1024 * 1024;
/** IDs per docker inspect call, so one argv never grows without bound. */
const INSPECT_CHUNK = 100;
/** Images one prune request removes at most. */
export const MAX_PRUNE_IMAGES = 500;

const IMAGE_ID_RE = /^sha256:[a-f0-9]{64}$/;
const CONTAINER_ID_RE = /^[a-f0-9]{64}$/;

export class DockerImagesError extends Error {
  constructor(message: string, public code: string, public statusCode: number) {
    super(message);
  }
}

export interface ContainerRef {
  id: string;
  name: string;
  /** The image ID the container was created from, sha256:... */
  imageId: string;
  /** The image reference the container was created with, as Config.Image. */
  image: string;
  state: string;
}

interface ImageRow {
  id: string;
  repoTags: string[];
  sizeBytes: number;
  created: string;
}

function lines(stdout: string): string[] {
  return stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function parseRow(line: string, what: string): unknown[] {
  let row: unknown;
  try {
    row = JSON.parse(line);
  } catch {
    throw new DockerImagesError(`docker returned a ${what} line that is not JSON`, "DOCKER_OUTPUT_INVALID", 502);
  }
  if (!Array.isArray(row)) throw new DockerImagesError(`docker returned an unexpected ${what} line`, "DOCKER_OUTPUT_INVALID", 502);
  return row;
}

/** Every container, running or stopped, with the image ID it uses. */
export async function listContainerRefs(run: CommandRunner): Promise<ContainerRef[]> {
  const { stdout } = await run("docker", ["ps", "-a", "-q", "--no-trunc"], { timeout: LIST_TIMEOUT_MS, maxBuffer: MAX_BUFFER });
  const ids = [...new Set(lines(stdout))].filter((id) => CONTAINER_ID_RE.test(id));
  const out: ContainerRef[] = [];
  for (const batch of chunks(ids, INSPECT_CHUNK)) {
    const { stdout: rows } = await run("docker", [
      "container", "inspect", "--format",
      "[{{json .Id}},{{json .Name}},{{json .Image}},{{json .Config.Image}},{{json .State.Status}}]",
      "--", ...batch,
    ], { timeout: LIST_TIMEOUT_MS, maxBuffer: MAX_BUFFER });
    for (const line of lines(rows)) {
      const [id, name, imageId, image, state] = parseRow(line, "container");
      if (typeof id !== "string" || typeof imageId !== "string") continue;
      out.push({
        id,
        name: typeof name === "string" ? name.replace(/^\//, "") : "",
        imageId,
        image: typeof image === "string" ? image : "",
        state: typeof state === "string" ? state : "unknown",
      });
    }
  }
  return out;
}

async function listImageRows(run: CommandRunner): Promise<ImageRow[]> {
  // With the containerd image store (Docker 29 on Unraid 7.3), an image that
  // lost its tag but kept its digest, which is what an update pull leaves
  // behind, is hidden from a plain listing yet shown by the dangling filter.
  // `-a` is not used instead: with the classic store it adds intermediate build
  // layers that other images depend on, which docker rmi refuses.
  const opts = { timeout: LIST_TIMEOUT_MS, maxBuffer: MAX_BUFFER };
  const [{ stdout: tagged }, { stdout: dangling }] = await Promise.all([
    run("docker", ["image", "ls", "-q", "--no-trunc"], opts),
    run("docker", ["image", "ls", "-q", "--no-trunc", "--filter", "dangling=true"], opts),
  ]);
  const ids = [...new Set([...lines(tagged), ...lines(dangling)])].filter((id) => IMAGE_ID_RE.test(id));
  const out: ImageRow[] = [];
  for (const batch of chunks(ids, INSPECT_CHUNK)) {
    const { stdout: rows } = await run("docker", [
      "image", "inspect", "--format",
      "[{{json .Id}},{{json .RepoTags}},{{json .Size}},{{json .Created}}]",
      "--", ...batch,
    ], { timeout: LIST_TIMEOUT_MS, maxBuffer: MAX_BUFFER });
    for (const line of lines(rows)) {
      const [id, tags, size, created] = parseRow(line, "image");
      if (typeof id !== "string" || !IMAGE_ID_RE.test(id)) continue;
      out.push({
        id,
        repoTags: Array.isArray(tags) ? tags.filter((t): t is string => typeof t === "string" && t !== "<none>:<none>") : [],
        sizeBytes: typeof size === "number" && Number.isFinite(size) && size >= 0 ? size : 0,
        created: typeof created === "string" ? created : "",
      });
    }
  }
  return out;
}

export async function listImages(run: CommandRunner): Promise<DockerImagesResponse> {
  const [rows, containers] = await Promise.all([listImageRows(run), listContainerRefs(run)]);
  const users = new Map<string, string[]>();
  for (const c of containers) {
    const list = users.get(c.imageId) ?? [];
    list.push(c.name);
    users.set(c.imageId, list);
  }
  const images: DockerImageInfo[] = rows.map((r) => {
    const inUseBy = (users.get(r.id) ?? []).sort();
    return {
      id: r.id,
      repoTags: r.repoTags,
      sizeBytes: r.sizeBytes,
      created: r.created,
      dangling: r.repoTags.length === 0,
      inUseBy,
      unused: inUseBy.length === 0,
    };
  });
  const sum = (list: DockerImageInfo[]) => list.reduce((n, i) => n + i.sizeBytes, 0);
  const dangling = images.filter((i) => i.dangling);
  const unused = images.filter((i) => i.unused);
  return {
    images,
    totals: {
      count: images.length,
      sizeBytes: sum(images),
      danglingCount: dangling.length,
      danglingSizeBytes: sum(dangling),
      unusedCount: unused.length,
      unusedSizeBytes: sum(unused),
    },
  };
}

export interface PruneRequest {
  dryRun: boolean;
  mode: DockerImagePruneMode;
  olderThanHours?: number;
}

export const PRUNE_FIELDS = ["dryRun", "mode", "olderThanHours"];

/** Hand validation: unknown fields, wrong types and a non-boolean dryRun are refused. */
export function parsePruneBody(body: unknown): PruneRequest | string {
  if (body === undefined || body === null) return { dryRun: false, mode: "dangling" };
  if (typeof body !== "object" || Array.isArray(body)) return "The body must be a JSON object";
  const b = body as Record<string, unknown>;
  const unknown = Object.keys(b).filter((k) => !PRUNE_FIELDS.includes(k));
  if (unknown.length > 0) return `Unknown field(s): ${unknown.join(", ")}`;
  if (b.dryRun !== undefined && typeof b.dryRun !== "boolean") return "dryRun must be true or false";
  if (b.mode !== undefined && b.mode !== "dangling" && b.mode !== "unused") return 'mode must be "dangling" or "unused"';
  if (b.olderThanHours !== undefined
    && (typeof b.olderThanHours !== "number" || !Number.isSafeInteger(b.olderThanHours) || b.olderThanHours < 0 || b.olderThanHours > 87600)) {
    return "olderThanHours must be a whole number from 0 to 87600";
  }
  return {
    dryRun: b.dryRun === true,
    mode: (b.mode as DockerImagePruneMode | undefined) ?? "dangling",
    ...(b.olderThanHours !== undefined ? { olderThanHours: b.olderThanHours as number } : {}),
  };
}

/** The images a prune would remove: never one a container references. */
export function pruneCandidates(images: DockerImageInfo[], req: PruneRequest, now: Date): DockerImageInfo[] {
  const cutoff = req.olderThanHours === undefined ? null : now.getTime() - req.olderThanHours * 3600_000;
  return images.filter((i) => {
    if (i.inUseBy.length > 0) return false;
    if (req.mode === "dangling" && !i.dangling) return false;
    if (cutoff !== null) {
      const created = Date.parse(i.created);
      // An image whose age cannot be read is never old enough.
      if (!Number.isFinite(created) || created > cutoff) return false;
    }
    return true;
  });
}

function stderrSummary(err: unknown): string {
  const e = err as { stderr?: unknown; message?: unknown };
  const text = typeof e?.stderr === "string" && e.stderr.trim() !== "" ? e.stderr : String(e?.message ?? err);
  return text.trim().split("\n").slice(-3).join(" ").slice(0, 300);
}

export async function pruneImages(run: CommandRunner, req: PruneRequest, now: Date): Promise<DockerImagePruneResponse> {
  const listing = await listImages(run);
  const candidates = pruneCandidates(listing.images, req, now);
  const base = {
    mode: req.mode,
    ...(req.olderThanHours !== undefined ? { olderThanHours: req.olderThanHours } : {}),
  };
  const plan = candidates.map(({ id, repoTags, sizeBytes, created }) => ({ id, repoTags, sizeBytes, created }));
  const planned = plan.reduce((n, i) => n + i.sizeBytes, 0);
  if (req.dryRun) {
    return { ...base, dryRun: true, images: plan, reclaimableBytes: planned, removed: [], failed: [], reclaimedBytes: 0, verified: false };
  }
  if (plan.length > MAX_PRUNE_IMAGES) {
    throw new DockerImagesError(
      `${plan.length} images match, more than the ${MAX_PRUNE_IMAGES} one request removes. Narrow it with olderThanHours or mode "dangling".`,
      "PRUNE_TOO_MANY", 422
    );
  }

  const failed: DockerImagePruneResponse["failed"] = [];
  for (const image of plan) {
    // An image under one tag or none is removed by its ID. docker refuses to
    // remove an image ID that several tags name, so such an image is removed by
    // the exact tags it had in the listing above. Either way docker itself also
    // refuses an image a container uses, since rmi runs without --force.
    const targets = image.repoTags.length > 1 ? image.repoTags : [image.id];
    try {
      await run("docker", ["rmi", "--", ...targets], { timeout: RMI_TIMEOUT_MS });
    } catch (err) {
      failed.push({ id: image.id, repoTags: image.repoTags, error: stderrSummary(err) });
    }
  }

  // Verify against a fresh listing rather than rmi's exit codes.
  const after = new Set((await listImageRows(run)).map((r) => r.id));
  const failedIds = new Set(failed.map((f) => f.id));
  const removed = plan.filter((i) => !after.has(i.id));
  const lingering = plan.filter((i) => after.has(i.id) && !failedIds.has(i.id));
  for (const i of lingering) failed.push({ id: i.id, repoTags: i.repoTags, error: "docker rmi reported success but the image is still listed" });
  return {
    ...base,
    dryRun: false,
    images: plan,
    reclaimableBytes: planned,
    removed: removed.map(({ id, repoTags, sizeBytes }) => ({ id, repoTags, sizeBytes })),
    failed,
    reclaimedBytes: removed.reduce((n, i) => n + i.sizeBytes, 0),
    verified: lingering.length === 0,
  };
}

// ── Update status ───────────────────────────────────────────────

/**
 * The key Unraid stores an image under: DockerUtil::ensureImageTag. A name
 * with no slash gets "library/", a missing tag becomes ":latest", and a
 * registry host is kept as it is.
 */
export function unraidImageKey(image: string): string {
  const ref = image.trim();
  if (ref === "") return "";
  if (ref.startsWith("sha256:")) return `${ref.slice(7, 19)}:latest`;
  if (ref.includes("@")) return ref;
  if (!ref.includes("/")) return unraidImageKey(`library/${ref}`);
  const lastSlash = ref.lastIndexOf("/");
  const colon = ref.indexOf(":", lastSlash);
  return colon === -1 ? `${ref}:latest` : ref;
}

/** Other spellings of the same image the cache may hold. */
function keyVariants(image: string): string[] {
  const key = unraidImageKey(image);
  const out = [key];
  const bare = key.replace(/^(docker\.io|index\.docker\.io|registry-1\.docker\.io)\//, "");
  out.push(bare);
  if (bare.startsWith("library/")) out.push(bare.slice("library/".length));
  return [...new Set(out)].filter(Boolean);
}

interface CacheEntry {
  local: string | null;
  remote: string | null;
  status: string | null;
}

function readEntry(raw: unknown): CacheEntry | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
  return { local: str(r.local), remote: str(r.remote), status: typeof r.status === "string" ? r.status : null };
}

export async function readUpdateCache(path: string, now: Date): Promise<{
  cache: DockerUpdateStatusResponse["cache"];
  entries: Map<string, CacheEntry>;
}> {
  const entries = new Map<string, CacheEntry>();
  let info;
  try {
    info = await stat(path);
  } catch {
    return { cache: { path, exists: false, modifiedAt: null, ageSeconds: null, entries: 0, error: "The update cache does not exist yet. Unraid writes it when it checks for updates." }, entries };
  }
  const modifiedAt = info.mtime.toISOString();
  const ageSeconds = Math.max(0, Math.round((now.getTime() - info.mtime.getTime()) / 1000));
  const meta = { path, exists: true, modifiedAt, ageSeconds };
  if (!info.isFile() || info.size > MAX_UPDATE_STATUS_BYTES) {
    return { cache: { ...meta, entries: 0, error: "The update cache is not a regular file of a plausible size, so it was not read." }, entries };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return { cache: { ...meta, entries: 0, error: "The update cache is not valid JSON." }, entries };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    // PHP's json_encode writes an empty array as [], which is a valid, empty cache.
    if (Array.isArray(parsed) && parsed.length === 0) return { cache: { ...meta, entries: 0 }, entries };
    return { cache: { ...meta, entries: 0, error: "The update cache is not a JSON object." }, entries };
  }
  for (const [key, raw] of Object.entries(parsed as Record<string, unknown>)) {
    const entry = readEntry(raw);
    if (entry) entries.set(key, entry);
  }
  return { cache: { ...meta, entries: entries.size }, entries };
}

/**
 * The same rule as Unraid's DockerUpdate::getUpdateStatus, except that a
 * missing digest on either side is "unknown" rather than "update available".
 */
function verdict(entry: CacheEntry | undefined): boolean | "unknown" {
  if (!entry) return "unknown";
  if (entry.status === "undef") return "unknown";
  if (entry.local && entry.remote) return entry.local !== entry.remote;
  return "unknown";
}

export async function updateStatus(run: CommandRunner, path: string, now: Date): Promise<DockerUpdateStatusResponse> {
  const [{ cache, entries }, containers] = await Promise.all([readUpdateCache(path, now), listContainerRefs(run)]);
  const list: DockerUpdateStatusEntry[] = containers
    .map((c) => {
      const variants = keyVariants(c.image);
      const key = variants.find((k) => entries.has(k));
      const entry = key ? entries.get(key) : undefined;
      return {
        name: c.name,
        id: c.id,
        image: c.image,
        cacheKey: key ?? variants[0] ?? "",
        state: c.state,
        updateAvailable: verdict(entry),
        localDigest: entry?.local ?? null,
        remoteDigest: entry?.remote ?? null,
        cacheStatus: entry?.status ?? null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    cache,
    containers: list,
    totals: {
      containers: list.length,
      updatesAvailable: list.filter((c) => c.updateAvailable === true).length,
      upToDate: list.filter((c) => c.updateAvailable === false).length,
      unknown: list.filter((c) => c.updateAvailable === "unknown").length,
    },
  };
}
