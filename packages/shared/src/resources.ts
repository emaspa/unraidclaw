export enum Resource {
  DOCKER = "docker",
  VMS = "vms",
  ARRAY = "array",
  DISK = "disk",
  SHARE = "share",
  INFO = "info",
  OS = "os",
  SERVICES = "services",
  NOTIFICATION = "notification",
  NETWORK = "network",
  ME = "me",
  LOGS = "logs",
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
      { key: "docker:delete", label: "Remove", description: "Remove containers", destructive: true },
    ],
  },
  {
    name: "Virtual Machines",
    description: "Manage VMs / libvirt domains",
    permissions: [
      { key: "vms:read", label: "List & Inspect", description: "List VMs and view details" },
      { key: "vms:update", label: "Control", description: "Start, stop, pause, resume, reboot VMs" },
      { key: "vms:delete", label: "Remove", description: "Remove VMs", destructive: true },
    ],
  },
  {
    name: "Array & Storage",
    description: "Array operations and disk information",
    permissions: [
      { key: "array:read", label: "Array Status", description: "View array state, capacity, and disk status" },
      { key: "array:update", label: "Array Operations", description: "Start/stop/pause/resume/cancel parity checks" },
      { key: "disk:read", label: "Disk Info", description: "View individual disk details and SMART data" },
      { key: "share:read", label: "List Shares", description: "List and view share configurations" },
    ],
  },
  {
    name: "System",
    description: "System information and control",
    permissions: [
      { key: "info:read", label: "System Info", description: "View system info, CPU, memory, uptime" },
      { key: "os:update", label: "Power Control", description: "Reboot or shutdown the server", destructive: true },
      { key: "services:read", label: "List Services", description: "View running services" },
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
    ],
  },
  {
    name: "Users",
    description: "User information",
    permissions: [
      { key: "me:read", label: "My Info", description: "View current user information" },
    ],
  },
  {
    name: "Logs",
    description: "System logs",
    permissions: [
      { key: "logs:read", label: "System Logs", description: "View syslog entries" },
    ],
  },
];

export const ALL_PERMISSION_KEYS: PermissionKey[] = PERMISSION_CATEGORIES.flatMap(
  (cat) => cat.permissions.map((p) => p.key)
);

export const DESTRUCTIVE_PERMISSIONS: PermissionKey[] = PERMISSION_CATEGORIES.flatMap(
  (cat) => cat.permissions.filter((p) => p.destructive).map((p) => p.key)
);
