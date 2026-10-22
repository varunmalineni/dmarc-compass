#!/usr/bin/env node
// Runs wrangler against wrangler.local.jsonc, creating it from the tracked
// wrangler.jsonc on first use.
//
// Why: on first deploy Wrangler provisions your D1 database and writes its
// ID back into the config it deployed from. Keeping that in a gitignored copy
// means the tracked wrangler.jsonc stays free of account-specific values, so
// `git status` stays clean and you can't commit your IDs by accident.
import { copyFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));

const LOCAL = "wrangler.local.jsonc";
if (!existsSync(LOCAL)) {
  copyFileSync("wrangler.jsonc", LOCAL);
  console.log(`Created ${LOCAL} (gitignored) from wrangler.jsonc.`);
}

const result = spawnSync("npx", ["wrangler", ...process.argv.slice(2), "-c", LOCAL], {
  stdio: "inherit",
  shell: process.platform === "win32",
});
process.exit(result.status ?? 1);
