export default {
  entry: ["src/index.ts"],
  format: "esm",
  target: "node22",
  outDir: "dist",
  dts: true,
  clean: true,
  noExternal: [/.*/],
  splitting: false,
};
