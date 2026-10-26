#!/usr/bin/env node
// Bundles scripts/bench/main.ts with the app's real source and runs it.
//   npm run bench -- typical | stress | small  [--regen] [--quick]
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const entry = process.env.BENCH_ENTRY || "main";
const out = join(root, ".wrangler", `bench-${entry}.mjs`);
await build({
  entryPoints: [join(root, `scripts/bench/${entry}.ts`)],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: out,
  external: ["node:*", "cloudflare:*"],
  logLevel: "warning",
});
const r = spawnSync(process.execPath, ["--expose-gc", "--disable-warning=ExperimentalWarning", out, ...process.argv.slice(2)], { stdio: "inherit", cwd: root });
process.exit(r.status ?? 1);
