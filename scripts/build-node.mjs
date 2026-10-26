#!/usr/bin/env node
// Bundles the self-hosted server (src/node/server.ts and the app it runs) into one
// file, dist/server.mjs, that plain Node can run. No Cloudflare code is included.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
await build({
  entryPoints: [join(root, "src/node/server.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: join(root, "dist/server.mjs"),
  external: ["node:*"],
  sourcemap: true,
  logLevel: "info",
});
