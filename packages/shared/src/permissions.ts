import {
  type PermissionKey,
  ALL_PERMISSION_KEYS,
  Resource,
  Action,
} from "./resources.js";

export type PermissionMatrix = Record<PermissionKey, boolean>;

export function createDefaultMatrix(defaultValue = false): PermissionMatrix {
  const matrix = {} as PermissionMatrix;
  for (const key of ALL_PERMISSION_KEYS) {
    matrix[key] = defaultValue;
  }
  return matrix;
}

export function isPermitted(
  matrix: PermissionMatrix,
  resource: Resource | string,
  action: Action | string
): boolean {
  const key = `${resource}:${action}` as PermissionKey;
  return matrix[key] === true;
}

export function applyPreset(presetName: PresetName): PermissionMatrix {
  return { ...PRESETS[presetName] };
}

const READ_ONLY_KEYS: PermissionKey[] = ALL_PERMISSION_KEYS.filter((k) =>
  k.endsWith(`:${Action.READ}`)
);

const DOCKER_MANAGER_KEYS: PermissionKey[] = [
  "docker:read",
  "docker:create",
  "docker:update",
  "docker:delete",
  "info:read",
  "logs:read",
];

const VM_MANAGER_KEYS: PermissionKey[] = [
  "vms:read",
  "vms:create",
  "vms:update",
  "vms:delete",
  "info:read",
  "logs:read",
];

function matrixFromKeys(keys: PermissionKey[]): PermissionMatrix {
  const matrix = createDefaultMatrix(false);
  for (const key of keys) {
    matrix[key] = true;
  }
  return matrix;
}

export const PRESETS = {
  "read-only": matrixFromKeys(READ_ONLY_KEYS),
  "docker-manager": matrixFromKeys(DOCKER_MANAGER_KEYS),
  "vm-manager": matrixFromKeys(VM_MANAGER_KEYS),
  "full-admin": createDefaultMatrix(true),
} as const;

export type PresetName = keyof typeof PRESETS;

export const PRESET_LABELS: Record<PresetName, string> = {
  "read-only": "Read-Only",
  "docker-manager": "Docker Manager",
  "vm-manager": "VM Manager",
  "full-admin": "Full Admin",
};
