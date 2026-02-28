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

export interface CreateShareRequest {
  name: string;
  comment?: string;
  allocator?: string;
  floor?: string;
  splitLevel?: string;
  include?: string[];
  exclude?: string[];
  useCache?: string;
}

export interface UpdateShareRequest {
  comment?: string;
  allocator?: string;
  floor?: string;
  splitLevel?: string;
  include?: string[];
  exclude?: string[];
  useCache?: string;
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
