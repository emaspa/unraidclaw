export enum Resource {
  DOCKER = "docker",
  VMS = "vms",
  ARRAY = "array",
  DISK = "disk",
  SHARE = "share",
  INFO = "info",
  CONFIG = "config",
  OS = "os",
  SERVICES = "services",
  NOTIFICATION = "notification",
  NETWORK = "network",
  ME = "me",
  API_KEY = "api_key",
  LOGS = "logs",
  FLASH = "flash",
  VARS = "vars",
}

export enum Action {
  READ = "read",
  CREATE = "create",
  UPDATE = "update",
  DELETE = "delete",
}

export type PermissionKey = `${Resource}:${Action}`;

export interface PermissionMeta {
  key: PermissionKey;
  label: string;
  description: string;
  destructive?: boolean;
}

export interface PermissionCategory {
  name: string;
  description: string;
  permissions: PermissionMeta[];
}

export const PERMISSION_CATEGORIES: PermissionCategory[] = [
  {
    name: "Docker",
    description: "Manage Docker containers",
    permissions: [
      { key: "docker:read", label: "List & Inspect", description: "List containers, view details and logs" },
      { key: "docker:update", label: "Control", description: "Start, stop, restart, pause, unpause containers" },
      { key: "docker:create", label: "Create", description: "Create new containers" },
      { key: "docker:delete", label: "Remove", description: "Remove containers", destructive: true },
    ],
  },
  {
    name: "Virtual Machines",
    description: "Manage VMs / libvirt domains",
    permissions: [
      { key: "vms:read", label: "List & Inspect", description: "List VMs and view details" },
      { key: "vms:update", label: "Control", description: "Start, stop, pause, resume, reboot VMs" },
      { key: "vms:create", label: "Create", description: "Create new VMs" },
      { key: "vms:delete", label: "Remove", description: "Remove VMs", destructive: true },
    ],
  },
  {
    name: "Array & Storage",
    description: "Array operations and disk information",
    permissions: [
      { key: "array:read", label: "Array Status", description: "View array state, capacity, and disk status" },
      { key: "array:update", label: "Array Operations", description: "Start/stop parity checks" },
      { key: "disk:read", label: "Disk Info", description: "View individual disk details and SMART data" },
      { key: "disk:update", label: "Disk Operations", description: "Disk management operations" },
      { key: "share:read", label: "List Shares", description: "List and view share configurations" },
      { key: "share:create", label: "Create Shares", description: "Create new shares" },
      { key: "share:update", label: "Update Shares", description: "Modify share settings" },
      { key: "share:delete", label: "Delete Shares", description: "Delete shares", destructive: true },
    ],
  },
  {
    name: "System",
    description: "System information and control",
    permissions: [
      { key: "info:read", label: "System Info", description: "View system info, CPU, memory, uptime" },
      { key: "config:read", label: "Read Config", description: "View system configuration" },
      { key: "config:update", label: "Update Config", description: "Modify system configuration" },
      { key: "os:update", label: "Power Control", description: "Reboot or shutdown the server", destructive: true },
      { key: "services:read", label: "List Services", description: "View running services" },
      { key: "services:update", label: "Control Services", description: "Start/stop system services" },
    ],
  },
  {
    name: "Notifications",
    description: "System notifications",
    permissions: [
      { key: "notification:read", label: "View", description: "List and read notifications" },
      { key: "notification:create", label: "Create", description: "Create new notifications" },
      { key: "notification:update", label: "Archive", description: "Archive notifications" },
      { key: "notification:delete", label: "Delete", description: "Delete notifications" },
    ],
  },
  {
    name: "Network",
    description: "Network information",
    permissions: [
      { key: "network:read", label: "View", description: "View network interfaces and configuration" },
      { key: "network:update", label: "Manage", description: "Modify network settings" },
    ],
  },
  {
    name: "Users & Access",
    description: "User information and API key management",
    permissions: [
      { key: "me:read", label: "My Info", description: "View current user information" },
      { key: "api_key:read", label: "List Keys", description: "List API keys" },
      { key: "api_key:create", label: "Create Keys", description: "Generate new API keys" },
      { key: "api_key:update", label: "Update Keys", description: "Modify API key settings" },
      { key: "api_key:delete", label: "Revoke Keys", description: "Revoke API keys" },
    ],
  },
  {
    name: "Logs & Diagnostics",
    description: "System logs and diagnostic data",
    permissions: [
      { key: "logs:read", label: "System Logs", description: "View system and application logs" },
      { key: "flash:read", label: "Flash Info", description: "View flash drive information" },
      { key: "vars:read", label: "System Vars", description: "View system variables (emhttp vars)" },
    ],
  },
];

export const ALL_PERMISSION_KEYS: PermissionKey[] = PERMISSION_CATEGORIES.flatMap(
  (cat) => cat.permissions.map((p) => p.key)
);

export const DESTRUCTIVE_PERMISSIONS: PermissionKey[] = PERMISSION_CATEGORIES.flatMap(
  (cat) => cat.permissions.filter((p) => p.destructive).map((p) => p.key)
);
