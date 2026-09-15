// Community Applications catalog.
//
// CA has no API. The whole catalog is one static JSON document that the CA
// plugin itself downloads (source: community.applications/include/paths.php).
// We fetch the same document, keep it in memory, and refresh it only when the
// tiny "last updated" sidecar says the catalog changed. Nothing here ever
// touches a shell, and no CA-internal on-disk cache is read.

import type { CaConfigEntry, CaConfigType, CaSearchResult } from "@unraidclaw/shared";

export const CA_FEED_URL = "https://assets.ca.unraid.net/feed/applicationFeed.json";
export const CA_FEED_LAST_UPDATED_URL =
  "https://assets.ca.unraid.net/feed/applicationFeed-lastUpdated.json";
export const CA_FEED_URL_BACKUP =
  "https://raw.githubusercontent.com/Squidly271/AppFeed/master/applicationFeed.json";
export const CA_FEED_LAST_UPDATED_URL_BACKUP =
  "https://raw.githubusercontent.com/Squidly271/AppFeed/master/applicationFeed-lastUpdated.json";

/** A raw `Config` element as it appears in the feed (PHP SimpleXML JSON shape). */
interface RawConfig {
  "@attributes"?: Record<string, string | undefined>;
  value?: string;
}

/** A raw catalog record. Only the fields we consume are typed. */
export interface RawCaApp {
  Name?: string | null;
  Repository?: string;
  Registry?: string;
  Repo?: string;
  Overview?: string;
  Icon?: string;
  Support?: string;
  Project?: string;
  WebUI?: string;
  Network?: string;
  Shell?: string;
  Privileged?: string;
  Requires?: string;
  ExtraParams?: string;
  PostArgs?: string;
  ExtraSearchTerms?: string;
  TemplateURL?: string;
  CategoryList?: string[];
  Config?: RawConfig | RawConfig[];
  // Version-1 template sections. Unraid expands these into Config entries only
  // for templates without version="2"; we always write version="2", so an app
  // whose ports and volumes live only here would install with no mappings.
  Networking?: unknown;
  Data?: unknown;
  Environment?: unknown;
  Labels?: unknown;
  Plugin?: string;
  PluginURL?: string;
  Deprecated?: string | boolean;
  Blacklist?: string | boolean;
  CABlacklist?: string | boolean;
  MinVer?: string;
  MaxVer?: string;
  TailscaleEnabled?: string;
  MyMAC?: string;
  errors?: unknown[];
}

export interface CaApp {
  raw: RawCaApp;
  name: string;
  repo: string;
  repository: string;
  description: string;
  icon: string;
  categories: string[];
  isPlugin: boolean;
  deprecated: boolean;
  config: CaConfigEntry[];
  /** Config entries we could not understand, so install must not proceed. */
  unknownConfigTypes: string[];
  /** Version-1 sections holding configuration that never reaches our template. */
  legacySections: string[];
  /** Lowercased haystack used for matching. */
  searchText: string;
}

export interface CaCatalog {
  apps: CaApp[];
  /** Feed vintage, ISO-8601. */
  updated: string;
  updatedTimestamp: number;
}

const CONFIG_TYPES: CaConfigType[] = ["Port", "Path", "Variable", "Label", "Device"];

// Unraid's xmlToVar() forces anything outside these sets to a safe default.
// Mirroring it here means our template says exactly what Unraid will do.
const PATH_MODES = new Set(["rw", "rw,slave", "rw,shared", "ro", "ro,slave", "ro,shared"]);
const PORT_MODES = new Set(["tcp", "udp"]);

function truthy(v: unknown): boolean {
  return v === true || (typeof v === "string" && v.toLowerCase() === "true");
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Normalize one `Config` element.
 *
 * `default` is the *effective* default: Unraid uses the element text when it is
 * non-empty and falls back to the Default attribute otherwise
 * (Helpers.php xmlToVar). Callers only ever need that resolved value.
 */
export function normalizeConfig(raw: RawCaApp): {
  config: CaConfigEntry[];
  unknownTypes: string[];
} {
  const list = raw.Config === undefined ? [] : Array.isArray(raw.Config) ? raw.Config : [raw.Config];
  const out: CaConfigEntry[] = [];
  const unknownTypes: string[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") {
      unknownTypes.push("(malformed entry)");
      continue;
    }
    const attrs = entry["@attributes"] ?? {};
    const type = str(attrs.Type) as CaConfigType;
    if (!CONFIG_TYPES.includes(type)) {
      // Dropping a field we do not understand would install an app missing a
      // mapping it needs, so the app is flagged un-installable instead.
      unknownTypes.push(type || "(missing Type)");
      continue;
    }

    const target = str(attrs.Target);
    const value = str(entry.value);
    const fallback = str(attrs.Default);

    let mode = str(attrs.Mode);
    if (type === "Path") mode = PATH_MODES.has(mode) ? mode : "rw";
    else if (type === "Port") mode = PORT_MODES.has(mode.toLowerCase()) ? mode.toLowerCase() : "tcp";
    else mode = "";

    // A Variable whose Default holds pipe-separated options is a dropdown, not
    // a free-text field (dm_CreateDocker.php builds a <select> from it). The
    // value is whichever option matches, or the first one. Writing the raw
    // Default would set the variable to the literal string "true|false".
    let choices: string[] | undefined;
    let effective: string;
    if (type === "Variable" && fallback.includes("|")) {
      choices = fallback.split("|");
      effective = choices.includes(value) ? value : choices[0];
    } else {
      effective = value !== "" ? value : fallback;
    }

    out.push({
      name: str(attrs.Name),
      target,
      type,
      default: effective,
      mode,
      description: str(attrs.Description),
      required: truthy(attrs.Required),
      mask: truthy(attrs.Mask),
      ...(choices ? { choices } : {}),
    });
  }
  return { config: out, unknownTypes };
}

/** Version-1 sections that carry configuration our version-2 template cannot. */
const LEGACY_SECTIONS = ["Networking", "Data", "Environment", "Labels"] as const;

function hasContent(v: unknown): boolean {
  if (v === undefined || v === null || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

/**
 * Turn a raw catalog record into our shape, or return null if the record is
 * unusable. 118 of ~4355 records are broken templates carrying an `errors`
 * array and a null Name; CA skips them and so do we.
 */
export function normalizeApp(raw: RawCaApp): CaApp | null {
  if (Array.isArray(raw.errors) && raw.errors.length > 0) return null;
  const name = str(raw.Name);
  if (!name) return null;

  const categories = Array.isArray(raw.CategoryList) ? raw.CategoryList.filter((c) => typeof c === "string") : [];
  const { config, unknownTypes } = normalizeConfig(raw);

  // Legacy sections only matter when the template has no version-2 Config to
  // carry the same data: that is the case where the ports and volumes would be
  // silently lost. A template with both is already fully described by Config.
  const legacySections =
    config.length === 0 ? LEGACY_SECTIONS.filter((k) => hasContent(raw[k])) : [];

  const app: CaApp = {
    raw,
    name,
    repo: str(raw.Repo),
    repository: str(raw.Repository),
    description: str(raw.Overview),
    icon: str(raw.Icon),
    categories,
    isPlugin: truthy(raw.Plugin) || str(raw.PluginURL) !== "",
    deprecated: truthy(raw.Deprecated),
    config,
    unknownConfigTypes: unknownTypes,
    legacySections: [...legacySections],
    searchText: "",
  };

  // CA matches each query word against name, repository, owner, overview and
  // the author-supplied extra search terms. One lowercased haystack per app is
  // enough for that and keeps search allocation-free per query.
  app.searchText = [
    name,
    app.repository,
    app.repo,
    app.description,
    str(raw.ExtraSearchTerms),
    categories.join(" "),
  ]
    .join("\n")
    .toLowerCase();

  return app;
}

export function parseCatalog(body: string): CaCatalog {
  const doc = JSON.parse(body) as { applist?: unknown; last_updated?: unknown; last_updated_timestamp?: unknown };
  if (!Array.isArray(doc.applist)) {
    throw new Error("Community Applications feed has no applist array");
  }
  const apps: CaApp[] = [];
  for (const raw of doc.applist as RawCaApp[]) {
    const app = normalizeApp(raw);
    if (app) apps.push(app);
  }
  const ts = typeof doc.last_updated_timestamp === "number" ? doc.last_updated_timestamp : 0;
  return {
    apps,
    updated: ts > 0 ? new Date(ts * 1000).toISOString() : str(doc.last_updated),
    updatedTimestamp: ts,
  };
}

export interface CaFeedOptions {
  feedUrl?: string;
  lastUpdatedUrl?: string;
  backupFeedUrl?: string;
  backupLastUpdatedUrl?: string;
  /** Re-check the sidecar at most this often. Defaults to 1 hour. */
  ttlMs?: number;
  /** Per-request timeout. Defaults to 60s; the catalog is ~17MB. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class CaFeedError extends Error {
  constructor(
    message: string,
    public code: string
  ) {
    super(message);
    this.name = "CaFeedError";
  }
}

export class CaFeed {
  private catalog: CaCatalog | null = null;
  private checkedAt = 0;
  private inflight: Promise<CaCatalog> | null = null;

  private readonly feedUrl: string;
  private readonly lastUpdatedUrl: string;
  private readonly backupFeedUrl: string;
  private readonly backupLastUpdatedUrl: string;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(opts: CaFeedOptions = {}) {
    this.feedUrl = opts.feedUrl ?? CA_FEED_URL;
    this.lastUpdatedUrl = opts.lastUpdatedUrl ?? CA_FEED_LAST_UPDATED_URL;
    this.backupFeedUrl = opts.backupFeedUrl ?? CA_FEED_URL_BACKUP;
    this.backupLastUpdatedUrl = opts.backupLastUpdatedUrl ?? CA_FEED_LAST_UPDATED_URL_BACKUP;
    this.ttlMs = opts.ttlMs ?? 60 * 60 * 1000;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  /** Cached catalog, refreshed when the upstream sidecar reports a new vintage. */
  async load(): Promise<CaCatalog> {
    const cached = this.catalog;
    if (cached && this.now() - this.checkedAt < this.ttlMs) return cached;
    if (this.inflight) return this.inflight;

    this.inflight = this.refresh(cached).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async refresh(cached: CaCatalog | null): Promise<CaCatalog> {
    if (cached) {
      // A ~40 byte probe decides whether the 17MB download is worth it. If the
      // probe fails, keep serving the copy we already have.
      const remote = await this.fetchLastUpdated().catch(() => null);
      if (remote !== null && remote === cached.updatedTimestamp) {
        this.checkedAt = this.now();
        return cached;
      }
    }

    let body: string;
    try {
      body = await this.fetchText(this.feedUrl);
    } catch (primaryErr) {
      try {
        body = await this.fetchText(this.backupFeedUrl);
      } catch {
        if (cached) {
          // Serving a known-stale catalog beats failing the request outright.
          this.checkedAt = this.now();
          return cached;
        }
        throw new CaFeedError(
          `Could not download the Community Applications catalog: ${(primaryErr as Error).message}`,
          "CA_FEED_UNAVAILABLE"
        );
      }
    }

    let parsed: CaCatalog;
    try {
      parsed = parseCatalog(body);
    } catch (err) {
      if (cached) {
        this.checkedAt = this.now();
        return cached;
      }
      throw new CaFeedError(
        `Community Applications catalog is malformed: ${(err as Error).message}`,
        "CA_FEED_MALFORMED"
      );
    }

    this.catalog = parsed;
    this.checkedAt = this.now();
    return parsed;
  }

  private async fetchLastUpdated(): Promise<number | null> {
    for (const url of [this.lastUpdatedUrl, this.backupLastUpdatedUrl]) {
      try {
        const body = await this.fetchText(url, 10_000);
        const doc = JSON.parse(body) as { last_updated_timestamp?: unknown };
        if (typeof doc.last_updated_timestamp === "number") return doc.last_updated_timestamp;
      } catch {
        // try the mirror
      }
    }
    return null;
  }

  private async fetchText(url: string, timeoutMs = this.timeoutMs): Promise<string> {
    const res = await this.fetchImpl(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`${url} responded ${res.status}`);
    return await res.text();
  }
}

export interface SearchOptions {
  limit?: number;
  includeDeprecated?: boolean;
  includePlugins?: boolean;
}

/** Every whitespace-separated word must appear somewhere in the app, as CA does it. */
export function searchCatalog(catalog: CaCatalog, query: string, opts: SearchOptions = {}): CaApp[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const limit = opts.limit ?? 25;

  const hits: CaApp[] = [];
  for (const app of catalog.apps) {
    if (!opts.includePlugins && app.isPlugin) continue;
    if (!opts.includeDeprecated && app.deprecated) continue;
    if (!words.every((w) => app.searchText.includes(w))) continue;
    hits.push(app);
  }

  // Exact then prefix name matches first; the catalog's own order otherwise.
  const q = query.toLowerCase();
  hits.sort((a, b) => rank(a, q) - rank(b, q));
  return hits.slice(0, limit);
}

function rank(app: CaApp, q: string): number {
  const name = app.name.toLowerCase();
  if (name === q) return 0;
  if (name.startsWith(q)) return 1;
  if (name.includes(q)) return 2;
  return 3;
}

/**
 * Resolve an app by name, optionally narrowed by owning repository.
 *
 * Name is not unique: 151 names are shared by two or more templates. Callers
 * get every candidate back so the route can answer 409 instead of guessing.
 */
export function findApps(catalog: CaCatalog, name: string, repo?: string): CaApp[] {
  const wanted = name.toLowerCase();
  let matches = catalog.apps.filter((a) => a.name.toLowerCase() === wanted);
  if (repo) {
    const wantedRepo = repo.toLowerCase();
    matches = matches.filter(
      (a) => a.repo.toLowerCase() === wantedRepo || a.repo.toLowerCase().startsWith(`${wantedRepo}'`)
    );
  }
  return matches;
}

export function toSearchResult(app: CaApp, installable: boolean): CaSearchResult {
  return {
    name: app.name,
    repo: app.repo,
    repository: app.repository,
    description: app.description,
    icon: app.icon,
    categories: app.categories,
    isPlugin: app.isPlugin,
    deprecated: app.deprecated,
    installable,
  };
}
