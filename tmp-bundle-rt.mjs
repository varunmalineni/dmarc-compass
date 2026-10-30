import { build } from "esbuild";
await build({
  entryPoints: ["/workspace/rt-test/static_unit.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: "/workspace/rt-test/static_unit.bundle.mjs",
  logLevel: "warning",
});
console.log("bundled");
