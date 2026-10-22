#!/usr/bin/env node
// First-run setup for dmarc-compass.
//
//   npm run setup               interactive
//   npm run setup -- --dry-run  print what would happen, change nothing
//
// For non-interactive use, provide ADMIN_USER and ADMIN_PASSWORD in the
// environment.
//
// What it does:
//   1. checks that Docker and a Cloudflare login are available
//   2. deploys the Worker (Wrangler creates the D1 database on first deploy)
//   3. sets the secrets: admin login + a random config-encryption key
//
// It is safe to re-run. An existing CONFIG_ENCRYPTION_KEY is never replaced,
// because that would make already-saved mailbox credentials undecryptable.
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import readline from "node:readline";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));

const DRY = process.argv.includes("--dry-run");
const LOCAL = "wrangler.local.jsonc";
const wrangler = (...args) => ["npx", ["wrangler", ...args, "-c", LOCAL]];

const say = (msg = "") => console.log(msg);
const step = (msg) => say(`\n\x1b[1m${msg}\x1b[0m`);
const fail = (msg) => {
  console.error(`\n\x1b[31m${msg}\x1b[0m`);
  process.exit(1);
};

function run(cmd, args, { input, capture = false } = {}) {
  if (DRY) {
    say(`  [dry-run] ${cmd} ${args.join(" ")}${input ? "   (secrets on stdin)" : ""}`);
    return Promise.resolve({ code: 0, out: "" });
  }
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: [input ? "pipe" : "inherit", "pipe", "inherit"],
      shell: process.platform === "win32",
    });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
      if (!capture) process.stdout.write(chunk);
    });
    if (input) child.stdin.end(input);
    child.on("close", (code) => resolve({ code: code ?? 1, out }));
  });
}

function ask(question, { hidden = false } = {}) {
  if (!process.stdin.isTTY) fail("No terminal available. Set ADMIN_USER and ADMIN_PASSWORD in the environment.");
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      // Echo the prompt itself but not what is typed.
      rl._writeToOutput = (text) => text.includes(question) && process.stdout.write(text);
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

const generatePassword = () => randomBytes(18).toString("base64url");

async function existingSecrets() {
  if (DRY) return new Set();
  const [cmd, args] = wrangler("secret", "list");
  const { code, out } = await run(cmd, args, { capture: true });
  if (code !== 0) return new Set(); // the Worker doesn't exist yet
  try {
    return new Set(JSON.parse(out.slice(out.indexOf("["), out.lastIndexOf("]") + 1)).map((s) => s.name));
  } catch {
    return new Set();
  }
}

say("\x1b[1mdmarc-compass setup\x1b[0m");
if (DRY) say("(dry run: nothing will be changed)");

// 1. Prerequisites ----------------------------------------------------------
step("1/3  Checking prerequisites");
if (!DRY) {
  if (spawnSync("docker", ["info"], { stdio: "ignore" }).status !== 0) {
    fail("Docker isn't running. Wrangler needs it to build the container image. Start Docker and re-run.");
  }
  say("  Docker: ok");
  const who = spawnSync("npx", ["wrangler", "whoami"], { encoding: "utf8", shell: process.platform === "win32" });
  if (!/You are logged in/i.test(who.stdout ?? "")) {
    say("  Not logged in to Cloudflare - opening the login flow...");
    if ((await run("npx", ["wrangler", "login"])).code !== 0) fail("Cloudflare login failed.");
  } else {
    say("  Cloudflare: logged in");
  }
}
if (!existsSync(LOCAL)) {
  if (!DRY) copyFileSync("wrangler.jsonc", LOCAL);
  say(`  Created ${LOCAL} (gitignored) - Wrangler records your account's resource IDs there.`);
}

// 2. Decide what needs setting ---------------------------------------------
const have = await existingSecrets();
const hasAdmin =
  (have.has("ADMIN_USER") && have.has("ADMIN_PASSWORD")) || (have.has("HTTP_SERVER_USER") && have.has("HTTP_SERVER_PASSWORD"));
const secrets = {};
let generatedPassword = null;
let url = null;

if (!hasAdmin) {
  step("2/3  Admin login");
  const user = process.env.ADMIN_USER || (process.stdin.isTTY ? (await ask("  Admin username [admin]: ")) || "admin" : "admin");
  let password = process.env.ADMIN_PASSWORD;
  if (!password) {
    password = await ask("  Admin password (press Enter to generate one): ", { hidden: true });
    if (!password) password = generatedPassword = generatePassword();
  }
  if (password.length < 12) fail("Use an admin password of at least 12 characters.");
  secrets.ADMIN_USER = user;
  secrets.ADMIN_PASSWORD = password;
} else {
  step("2/3  Admin login");
  say("  Already configured - leaving it as is.");
}

if (have.has("CONFIG_ENCRYPTION_KEY")) {
  say("  Config encryption key: already set - keeping it.");
} else {
  secrets.CONFIG_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  say("  Generated a config encryption key.");
}

// 3. Deploy, then set secrets ----------------------------------------------
step("3/3  Deploying (the first build takes a few minutes)");
{
  const [cmd, args] = wrangler("deploy");
  const { code, out } = await run(cmd, args);
  if (code !== 0) fail("Deploy failed - see the output above.");
  url = out.match(/https:\/\/[\w.-]+\.workers\.dev/)?.[0] ?? null;
}

if (Object.keys(secrets).length) {
  say("\n  Setting secrets...");
  const [cmd, args] = wrangler("secret", "bulk");
  const { code } = await run(cmd, args, { input: JSON.stringify(secrets) });
  if (code !== 0) fail("Setting secrets failed - see the output above.");
}

say("\n\x1b[32mDone.\x1b[0m");
if (url) say(`  Your dashboard:  ${url}`);
say(`  Admin page:      ${url ?? "<your-worker-url>"}/admin`);
if (secrets.ADMIN_USER) {
  say(`\n  Username: ${secrets.ADMIN_USER}`);
  if (generatedPassword) say(`  Password: ${generatedPassword}   <- shown once; save it now`);
}
say("\n  Next: open the admin page, enter the mailbox that receives your DMARC reports, and run a sync.");
