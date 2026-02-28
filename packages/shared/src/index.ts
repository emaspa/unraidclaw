export {
  Resource,
  Action,
  type PermissionKey,
  type PermissionMeta,
  type PermissionCategory,
  PERMISSION_CATEGORIES,
  ALL_PERMISSION_KEYS,
  DESTRUCTIVE_PERMISSIONS,
} from "./resources.js";

export {
  type PermissionMatrix,
  type PresetName,
  createDefaultMatrix,
  isPermitted,
  applyPreset,
  PRESETS,
  PRESET_LABELS,
} from "./permissions.js";

export * from "./api-types.js";
