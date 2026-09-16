/** @type {import('tsup').Options} */
export default {
  entry: { unraidclaw: "src/index.ts" },
  format: ["cjs"],
  target: "node22",
  noExternal: [/.*/],
  splitting: false,
  clean: true,
  // Release builds stamp the release version; other builds keep package.json's.
  define: { "process.env.UNRAIDCLAW_BUILD_VERSION": JSON.stringify(process.env.UNRAIDCLAW_BUILD_VERSION ?? "") },
};
