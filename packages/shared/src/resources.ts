export enum Resource {
  DOCKER = "docker",
  CA = "ca",
  PLUGINS = "plugins",
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
      { key: "docker:create", label: "Create", description: "Create and start new containers" },
      { key: "docker:update", label: "Control", description: "Start, stop, restart, pause, unpause containers" },
      { key: "docker:delete", label: "Remove", description: "Remove containers", destructive: true },
    ],
  },
  {
    name: "Community Applications",
    description: "Search the Community Applications catalog and install apps",
    permissions: [
      { key: "ca:read", label: "Search & Inspect", description: "Search the CA catalog and view app templates" },
      { key: "ca:create", label: "Install", description: "Install a CA app as a new Docker container" },
      { key: "ca:update", label: "Update", description: "Pull a newer image for an installed app and recreate it from its saved template" },
      { key: "ca:delete", label: "Remove", description: "Remove an installed app's container, keeping its template, image, volumes and appdata", destructive: true },
    ],
  },
  {
    name: "Plugins",
    description: "Manage Unraid .plg plugins through the system plugin manager",
    permissions: [
      { key: "plugins:read", label: "List & Inspect", description: "List installed plugins and read their metadata" },
      { key: "plugins:create", label: "Install", description: "Install a plugin from an explicit .plg URL, which runs the plugin's own scripts as root", destructive: true },
      { key: "plugins:update", label: "Check & Update", description: "Download a plugin file to stage an update, and apply updates by running the plugin's scripts as root", destructive: true },
      { key: "plugins:delete", label: "Remove", description: "Remove a plugin; its own removal scripts may delete its data", destructive: true },
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
      { key: "array:update", label: "Array Operations", description: "Start/stop array, parity check control" },
      { key: "disk:read", label: "Disk Info", description: "View array data and parity disk details, temperature, status and available disk usage" },
      { key: "share:read", label: "List Shares", description: "List and view share configurations" },
      { key: "share:update", label: "Edit Share Settings", description: "Update share comment, allocator, split level, floor" },
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
