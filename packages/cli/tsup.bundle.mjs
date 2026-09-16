/** @type {import('tsup').Options} */
export default {
  entry: { unraidclaw: "src/index.ts" },
  format: ["cjs"],
  target: "node22",
  noExternal: [/.*/],
  splitting: false,
  clean: true,
};
