// ── Health ──────────────────────────────────────────────────────
export interface HealthResponse {
  status: "ok" | "degraded" | "error";
  version: string;
  uptime: number;
  graphqlReachable: boolean;
}

// ── Docker ─────────────────────────────────────────────────────
export interface DockerContainer {
  id: string;
  names: string[];
  image: string;
  state: string;
  status: string;
  autoStart: boolean;
}

export interface DockerContainerDetail extends DockerContainer {
  ports: DockerPort[];
  mounts: DockerMount[];
  networkMode: string;
}

export interface DockerPort {
  ip: string;
  privatePort: number;
  publicPort: number;
  type: string;
}

export interface DockerMount {
  source: string;
  destination: string;
  mode: string;
}

export interface DockerActionResponse {
  id: string;
  names: string[];
  state: string;
  status: string;
}

export interface DockerLogsRequest {
  tail?: number;
  since?: string;
}

export interface DockerLogsResponse {
  id: string;
  logs: string;
}

// ── Docker images and update status ────────────────────────────
export interface DockerImageInfo {
  /** Full image ID, sha256:... */
  id: string;
  /** Tags such as "lscr.io/linuxserver/plex:latest". Empty for a dangling image. */
  repoTags: string[];
  sizeBytes: number;
  /** Creation time as docker reports it (RFC 3339). */
  created: string;
  /** True when the image has no tag. */
  dangling: boolean;
  /** Names of the containers, running or stopped, created from this image. */
  inUseBy: string[];
  /** True when no container references the image. */
  unused: boolean;
}

export interface DockerImagesResponse {
  images: DockerImageInfo[];
  totals: {
    count: number;
    sizeBytes: number;
    danglingCount: number;
    danglingSizeBytes: number;
    unusedCount: number;
    unusedSizeBytes: number;
  };
}

/** "dangling": untagged images no container uses. "unused": any image no container uses. */
export type DockerImagePruneMode = "dangling" | "unused";

export interface DockerImagePruneRequest {
  dryRun?: boolean;
  mode?: DockerImagePruneMode;
  /** Only images created at least this many hours ago. */
  olderThanHours?: number;
}

export interface DockerImagePruneResponse {
  dryRun: boolean;
  mode: DockerImagePruneMode;
  olderThanHours?: number;
  /** Exactly the images selected for removal. */
  images: Array<{ id: string; repoTags: string[]; sizeBytes: number; created: string }>;
  /** Sum of the selected images' sizes. Shared layers can make the real figure smaller. */
  reclaimableBytes: number;
  removed: Array<{ id: string; repoTags: string[]; sizeBytes: number }>;
  failed: Array<{ id: string; repoTags: string[]; error: string }>;
  reclaimedBytes: number;
  /** True when a fresh listing shows every image docker removed without error is gone. */
  verified: boolean;
}

export interface DockerUpdateStatusEntry {
  name: string;
  id: string;
  /** The image reference the container was created with. */
  image: string;
  /** The key looked up in Unraid's update cache. */
  cacheKey: string;
  state: string;
  updateAvailable: boolean | "unknown";
  localDigest: string | null;
  remoteDigest: string | null;
  /** Unraid's own status string for the entry: "true", "false" or "undef". */
  cacheStatus: string | null;
}

export interface DockerUpdateStatusResponse {
  cache: {
    path: string;
    exists: boolean;
    /** When Unraid last wrote the cache, so the caller can judge how stale it is. */
    modifiedAt: string | null;
    ageSeconds: number | null;
    entries: number;
    /** Why the cache could not be used, when it could not. Every container is then "unknown". */
    error?: string;
  };
  containers: DockerUpdateStatusEntry[];
  totals: { containers: number; updatesAvailable: number; upToDate: number; unknown: number };
}

// ── Community Applications ─────────────────────────────────────

/** One row of a CA search result. */
export interface CaSearchResult {
  /** Template name, e.g. "plex". Not unique across repositories. */
  name: string;
  /** Owning repository, e.g. "linuxserver's Repository". Disambiguates duplicate names. */
  repo: string;
  /** Docker image, e.g. "lscr.io/linuxserver/plex". Absent for plugin entries. */
  repository: string;
  description: string;
  icon: string;
  categories: string[];
  /** True when this entry installs a .plg plugin rather than a container. */
  isPlugin: boolean;
  deprecated: boolean;
  /** False when install would be refused; see `blockers` on the detail endpoint. */
  installable: boolean;
}

export interface CaSearchResponse {
  query: string;
  total: number;
  results: CaSearchResult[];
  /** Feed vintage, ISO-8601. */
  feedUpdated: string;
}

export type CaConfigType = "Port" | "Path" | "Variable" | "Label" | "Device";

/** One configurable field of a CA template. */
export interface CaConfigEntry {
  /** Human label, e.g. "Host Path for /config". Accepted as an override key. */
  name: string;
  /** Container-side target: port number, container path, or variable name. Accepted as an override key. */
  target: string;
  type: CaConfigType;
  /** Value used when the caller supplies no override. Empty string means unset. */
  default: string;
  /** "rw"/"ro" for Path, "tcp"/"udp" for Port, empty otherwise. */
  mode: string;
  description: string;
  required: boolean;
  /** True for secrets; the WebGUI masks these. */
  mask: boolean;
  /**
   * Allowed values, when the template declares this field as a dropdown by
   * writing its options pipe-separated in Default (Variable fields only).
   * `default` is then one of these. Absent for free-text fields.
   */
  choices?: string[];
}

/** Why an app cannot be installed through this API. */
export interface CaBlocker {
  code: string;
  message: string;
}

export interface CaAppDetail extends CaSearchResult {
  registry: string;
  support: string;
  project: string;
  webui: string;
  network: string;
  privileged: boolean;
  /** Free-text prerequisites from the template author. Advisory only. */
  requires: string;
  config: CaConfigEntry[];
  /** Ports, paths and variables split out of `config` for convenience. */
  ports: CaConfigEntry[];
  paths: CaConfigEntry[];
  variables: CaConfigEntry[];
  /** Required fields with no default. Install fails unless these are overridden. */
  missingRequired: string[];
  blockers: CaBlocker[];
}

/** Returned with HTTP 409 when a name matches more than one template. */
export interface CaAmbiguousMatch {
  name: string;
  candidates: Array<{ name: string; repo: string; repository: string }>;
}

export interface CaInstallRequest {
  /** Disambiguates when several templates share the app name. */
  repo?: string;
  /** Container name. Defaults to the template name. */
  name?: string;
  /** Values for template fields, keyed by a config entry's `name` or `target`. */
  overrides?: Record<string, string>;
  /** Resolve and validate everything, then return the plan without changing the system. */
  dryRun?: boolean;
}

export interface CaInstallPlan {
  name: string;
  repo: string;
  image: string;
  network: string;
  ports: string[];
  volumes: string[];
  env: string[];
  templatePath: string;
  templateXml: string;
  /**
   * A preview of the `docker run` argv Unraid's docker manager will build from
   * this template, for review before applying an install. It is a
   * reconstruction, not the command that runs: Unraid builds that itself and
   * adds host-derived values the preview omits, such as TZ, HOST_HOSTNAME and
   * Label entries. UnraidClaw never executes this.
   */
  dockerCommandPreview: string[];
}

export interface CaInstallResponse {
  dryRun: boolean;
  plan: CaInstallPlan;
  /** Absent on a dry run. */
  containerId?: string;
  /** Advisory notes, e.g. the template's `Requires` text. */
  warnings: string[];
}

/** Body of the update and remove endpoints. A preview flag and nothing else. */
export interface CaLifecycleRequest {
  /** Check everything and report what would happen, without changing anything. */
  dryRun?: boolean;
}

/** What an update would recreate the container as, taken from its saved template. */
export interface CaUpdatePlan {
  /** The installed container's name. */
  name: string;
  /** The saved docker-manager template the configuration comes from. */
  templatePath: string;
  image: string;
  network: string;
  ports: string[];
  volumes: string[];
  env: string[];
  /** `key=value` labels the template asks for, beyond Unraid's own. */
  labels: string[];
  /** The exact `docker create` argv UnraidClaw runs. Not a shell string. */
  dockerCommand: string[];
}

export interface CaUpdateResponse {
  dryRun: boolean;
  name: string;
  /** The container as it stands after the call: the new one once updated. */
  containerId: string;
  templatePath: string;
  image: string;
  /** Image id the app was running before the call. */
  previousImageId: string;
  /** Image id it runs now. Absent on a dry run. */
  imageId?: string;
  /** False when the pulled image was already the one running, so nothing was recreated. */
  updated: boolean;
  /** Whether the app is running now. */
  running: boolean;
  /** Whether it was running before, which the update restores. */
  wasRunning: boolean;
  plan: CaUpdatePlan;
  warnings: string[];
}

/** What a removal deliberately leaves behind. */
export interface CaRemovePreserved {
  /** The saved template, kept so the app can be recreated with this configuration. */
  templatePath: string;
  image: string;
  imageId: string;
  /** Named Docker volumes, none of which are removed. */
  volumes: string[];
  /** Host directories bind-mounted into the container, appdata included. Never touched. */
  hostPaths: string[];
}

export interface CaRemoveResponse {
  dryRun: boolean;
  name: string;
  containerId: string;
  removed: boolean;
  /** Whether the container is running. False once it has been removed. */
  running: boolean;
  preserved: CaRemovePreserved;
  warnings: string[];
}

// ── Container settings (saved templates) ────────────────

/**
 * Top-level elements of a saved docker-manager template that a template edit
 * may set. Everything else in the template is metadata the Docker tab shows and
 * docker never sees, and an edit leaves it exactly as it was.
 */
export type TemplateSettingKey =
  | "Repository"
  | "Registry"
  | "Network"
  | "MyIP"
  | "MyMAC"
  | "ExtraNetworks"
  | "Privileged"
  | "ExtraParams"
  | "PostArgs"
  | "CPUset"
  | "Memory"
  | "WebUI"
  | "Icon"
  | "Shell"
  | "TailscaleEnabled"
  | "TailscaleIsExitNode"
  | "TailscaleHostname"
  | "TailscaleExitNodeIP"
  | "TailscaleSSH"
  | "TailscaleLANAccess"
  | "TailscaleUserspaceNetworking"
  | "TailscaleServe"
  | "TailscaleServePort"
  | "TailscaleServeTarget"
  | "TailscaleServeLocalPath"
  | "TailscaleServeProtocol"
  | "TailscaleServeProtocolPort"
  | "TailscaleServePath"
  | "TailscaleWebUI"
  | "TailscaleDParams"
  | "TailscaleParams"
  | "TailscaleRoutes"
  | "TailscaleAcceptRoutes"
  | "TailscaleStateDir"
  | "TailscaleTroubleshooting";

/** One `<Config>` entry of a saved template, as the Docker tab shows it. */
export interface TemplateConfigView {
  name: string;
  /** Container port, container path, variable or label name. Usually empty for a Device. */
  target: string;
  type: CaConfigType | string;
  /** "tcp"/"udp" for a Port, "rw"/"ro" (optionally ",slave" or ",shared") for a Path. */
  mode: string;
  /** The configured value. `***` when the entry is masked and set. */
  value: string;
  /** The template's default. Empty when the entry is masked. */
  default: string;
  description: string;
  display: string;
  required: boolean;
  mask: boolean;
}

export interface TemplateView {
  name: string;
  templatePath: string;
  /** Every settable element the template carries, with its current text. */
  settings: Partial<Record<TemplateSettingKey, string>>;
  config: TemplateConfigView[];
}

/**
 * A `<Config>` entry to add or change. An existing entry is matched by type and
 * target, plus mode for a Port (so 53/tcp and 53/udp are different entries) and
 * value for a Device (whose target is normally empty). Attributes left out keep
 * their current value, or take the Docker tab's default on a new entry.
 */
export interface TemplateConfigEdit {
  type: CaConfigType;
  target?: string;
  value: string;
  name?: string;
  mode?: string;
  default?: string;
  description?: string;
  display?: string;
  required?: boolean;
  mask?: boolean;
  /** For a Device only: the device currently configured, when this edit replaces it with `value`. */
  replaces?: string;
}

/** A `<Config>` entry to delete, matched the same way as an edit. */
export interface TemplateConfigRef {
  type: CaConfigType;
  target?: string;
  mode?: string;
  /** For a Device: the host device path. */
  value?: string;
}

export interface TemplateEditRequest {
  settings?: Partial<Record<TemplateSettingKey, string>>;
  config?: TemplateConfigEdit[];
  removeConfig?: TemplateConfigRef[];
  /**
   * Pull the newest image for the template's tag first, and rebuild with it.
   * With nothing else to change this is an update, for any container,
   * privileged ones included; when the image is already the newest, nothing
   * is rebuilt.
   */
  pull?: boolean;
  dryRun?: boolean;
}

/** One field the edit changes, with masked values shown as `***`. */
export interface TemplateChange {
  /** e.g. "Network", or "Variable PUID", "Port 8096/tcp", "Device /dev/dri". */
  field: string;
  /** Empty when the field is being added. */
  before: string;
  /** Empty when the field is being removed. */
  after: string;
}

export interface TemplateEditPlan {
  name: string;
  templatePath: string;
  changes: TemplateChange[];
  /**
   * The command Unraid's own docker manager builds from the edited template,
   * with masked values replaced by `***`. It is a shell string because that is
   * what the Docker tab runs: Extra Parameters and Post Arguments are shell
   * fragments by design.
   */
  dockerCommand: string;
  /** Networks the rebuilt container is connected to after it is created. */
  extraNetworks: string[];
  /** Host paths the edit adds that do not exist yet, created as nobody:users. */
  hostPathsToCreate: string[];
}

export interface TemplateEditResponse {
  dryRun: boolean;
  name: string;
  /** The container as it stands after the call: the rebuilt one once edited. */
  containerId: string;
  templatePath: string;
  /** The copy of the template as it was before the edit. Absent on a dry run. */
  backupPath?: string;
  /** True once the container was rebuilt from the edited template. */
  rebuilt: boolean;
  running: boolean;
  /** Whether it was running before, which the rebuild restores. */
  wasRunning: boolean;
  /** True when the image was pulled. */
  pulled?: boolean;
  /** The image id the container ran before, and the one it runs now. */
  previousImageId?: string;
  imageId?: string;
  plan: TemplateEditPlan;
  warnings: string[];
}

// ── Plugins (.plg) ──────────────────────────────────────

export interface PluginSummary {
  /** Plugin file basename, e.g. "unassigned.devices.plg". This is the id used everywhere in this API. */
  file: string;
  /** name attribute of the .plg <PLUGIN> tag. */
  name: string;
  author: string;
  version: string;
  /** pluginURL attribute. Empty when the plugin cannot check for updates. */
  pluginURL: string;
  /** Absolute path of the .plg the /var/log/plugins symlink points at. */
  path: string;
  /** Unraid OS built-in (unRAIDServer) or a plugin file outside /boot/config/plugins. Mutations are refused. */
  builtin: boolean;
  /** Version staged in /tmp/plugins by a previous check, when one is staged. */
  stagedVersion?: string;
  updateAvailable?: boolean;
}

export interface PluginListResponse {
  plugins: PluginSummary[];
  total: number;
  skipped: Array<{ file: string; reason: string }>;
}

export interface PluginFileEntry {
  /** Target path of the FILE element, or "" when the element only runs a command. */
  name: string;
  /** Method attribute, defaulting to "install". */
  method: string;
  source: "URL" | "LOCAL" | "INLINE" | "none";
  /** The Run attribute (the interpreter), never the script body. */
  run: string;
  /** Download URL for source "URL". Never returned for INLINE content. */
  url: string;
}

export interface PluginDetail extends PluginSummary {
  min: string;
  max: string;
  support: string;
  icon: string;
  launch: string;
  /** noInstall plugins are one-shot scripts that never register; UnraidClaw refuses to install them. */
  noInstall: boolean;
  /** Structure only. INLINE script bodies are never returned. */
  files: PluginFileEntry[];
  /** CHANGES text, truncated. */
  changes: string;
}

export interface PluginInstallRequest {
  url: string;
  dryRun?: boolean;
}

export interface PluginActionRequest {
  dryRun?: boolean;
}

export interface PluginPlan {
  action: "install" | "check" | "update" | "remove";
  file: string;
  /** Ordered description of what a non-dry-run call would do. */
  steps: string[];
  warnings: string[];
}

export interface PluginInstallResponse {
  dryRun: boolean;
  plan: PluginPlan;
  url: string;
  installed?: PluginSummary;
  registered?: boolean;
  output?: string;
}

export interface PluginCheckResponse {
  dryRun: boolean;
  plan: PluginPlan;
  file: string;
  installedVersion: string;
  latestVersion?: string;
  updateAvailable?: boolean;
  output?: string;
}

export interface PluginUpdateResponse {
  dryRun: boolean;
  plan: PluginPlan;
  file: string;
  previousVersion: string;
  installedVersion?: string;
  verified?: boolean;
  output?: string;
}

export interface PluginRemoveResponse {
  dryRun: boolean;
  plan: PluginPlan;
  file: string;
  removed?: boolean;
  output?: string;
}

// ── VMs ────────────────────────────────────────────────────────
export interface VM {
  id: string;
  name: string;
  state: string;
  uuid: string;
  coreCount: number;
  ramAllocation: string;
  primaryGPU: string;
  description: string;
  autoStart: boolean;
}

export interface VMActionResponse {
  id: string;
  name: string;
  state: string;
  uuid: string;
}

// ── Array ──────────────────────────────────────────────────────
export interface ArrayStatus {
  state: string;
  capacity: {
    kilobytes: { free: string; used: string; total: string };
    disks: { free: string; used: string; total: string };
  };
  disks: ArrayDisk[];
  parityChecks: ParityCheck[];
}

export interface ArrayDisk {
  id: string;
  name: string;
  device: string;
  size: string;
  status: string;
  temp: number | null;
  fsType: string;
  color: string;
}

export interface ParityCheck {
  date: string;
  duration: string;
  speed: string;
  status: string;
  errors: number;
}

export interface ParityActionResponse {
  success: boolean;
  message: string;
}

// ── Disks ──────────────────────────────────────────────────────
export interface DiskInfo {
  id: string;
  name: string;
  device: string;
  size: string;
  temp: number | null;
  status: string;
  fsType: string;
  smart: SmartData | null;
}

export interface SmartData {
  health: string;
  temperature: number | null;
  powerOnHours: number | null;
  attributes: SmartAttribute[];
}

export interface SmartAttribute {
  id: number;
  name: string;
  value: number;
  worst: number;
  threshold: number;
  raw: string;
}

// ── Shares ─────────────────────────────────────────────────────
export interface Share {
  name: string;
  comment: string;
  allocator: string;
  floor: string;
  splitLevel: string;
  include: string[];
  exclude: string[];
  useCache: string;
  free: string;
  used: string;
  size: string;
}

export interface UpdateShareRequest {
  comment?: string;
  allocator?: string;
  floor?: string;
  splitLevel?: string;
}

// ── System ─────────────────────────────────────────────────────
export interface SystemInfo {
  os: {
    platform: string;
    hostname: string;
    uptime: number;
    version: string;
  };
  cpu: {
    model: string;
    cores: number;
    threads: number;
    frequency: string;
  };
  memory: {
    total: string;
    used: string;
    free: string;
    cached: string;
  };
  versions: {
    unraid: string;
    kernel: string;
  };
}

export interface SystemMetrics {
  cpu: { usage: number; loadAverage: number[] };
  memory: { totalBytes: number; usedBytes: number; freeBytes: number; usagePercent: number };
  uptime: number;
}

export interface ServiceInfo {
  name: string;
  state: string;
  autoStart: boolean;
}

// ── Notifications ──────────────────────────────────────────────
export interface Notification {
  id: string;
  title: string;
  subject: string;
  description: string;
  importance: "alert" | "warning" | "normal";
  type: string;
  timestamp: string;
  archived: boolean;
}

export interface CreateNotificationRequest {
  title: string;
  subject: string;
  description: string;
  importance?: "alert" | "warning" | "normal";
  type?: string;
}

// ── Network ────────────────────────────────────────────────────
export interface NetworkInterface {
  name: string;
  ipAddress: string;
  ipv6Address: string;
  macAddress: string;
  speed: string;
  status: string;
  mtu: number;
}

export interface NetworkInfo {
  hostname: string;
  domain: string;
  gateway: string;
  dns: string[];
  interfaces: NetworkInterface[];
}

// ── Users ──────────────────────────────────────────────────────
export interface UserInfo {
  name: string;
  description: string;
  role: string;
}

// ── Logs ───────────────────────────────────────────────────────
export interface LogEntry {
  timestamp: string;
  facility: string;
  severity: string;
  message: string;
}

export interface LogsResponse {
  entries: LogEntry[];
  total: number;
}

// ── Generic API envelope ───────────────────────────────────────
export interface ApiSuccess<T> {
  ok: true;
  data: T;
}

export interface ApiError {
  ok: false;
  error: {
    code: string;
    message: string;
  };
}

export type ApiResponse<T> = ApiSuccess<T> | ApiError;
