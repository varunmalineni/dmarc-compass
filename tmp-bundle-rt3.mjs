import { build } from "esbuild";
await build({
  entryPoints: ["/workspace/rt-test/imap_inject.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: "/workspace/rt-test/imap_inject.bundle.mjs",
  logLevel: "warning",
});
console.log("bundled");
