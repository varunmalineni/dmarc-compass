import { build } from "esbuild";
await build({
  entryPoints: ["/workspace/rt-test/symlink_test.ts"],
  bundle: true, platform: "node", format: "esm", target: "node22",
  outfile: "/workspace/rt-test/symlink_test.bundle.mjs", logLevel: "warning",
});
console.log("bundled");
