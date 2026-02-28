/** @type {import('tsup').Options} */
export default {
  noExternal: [/.*/],  // Bundle ALL dependencies into single file (no node_modules on Unraid)
};
