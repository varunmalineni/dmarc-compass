#!/usr/bin/env node
// End-to-end test of the self-hosted image with the real parser and a real IMAP server.
//
//   npm run e2e:docker            builds the image first
//   npm run e2e:docker -- --no-build --image my-image:tag --keep
//
// It starts GreenMail (a test mail server), puts DMARC reports in a mailbox, starts the
// dmarc-compass image next to it, and drives it over HTTP like a person would (the steps
// are in lib.mjs). Needs Docker. Everything it creates is removed afterwards.

import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { KEY, PASSWORD, BACKUP_COUNT_SCRIPT, PARSER_ENV_SCRIPT, appendMessages, check, createClient, finish, runScenario, until } from "./lib.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const args = process.argv.slice(2);
const image = args.includes("--image") ? args[args.indexOf("--image") + 1] : "dmarc-compass:e2e";
const build = !args.includes("--no-build");
const keep = args.includes("--keep");
const GREENMAIL = "greenmail/standalone:2.1.8";
const tag = `dc-e2e-${process.pid}`;
const names = { mail: `${tag}-mail`, app: `${tag}-app`, vol: `${tag}-data` };

const docker = (...a) => execFileSync("docker", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

async function main() {
  const c = createClient();
  if (build) {
    console.log(`Building ${image} ...`);
    docker("build", "-q", "-f", join(root, "deploy/docker/Dockerfile"), "-t", image, root);
  }

  console.log("Starting the test mail server ...");
  docker("run", "-d", "--name", names.mail, "-p", "127.0.0.1::8081", "-p", "127.0.0.1::3143",
    "-e", "GREENMAIL_OPTS=-Dgreenmail.setup.test.imap -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.users=dmarc:secretpw", GREENMAIL);
  const hostPort = (p) => Number(docker("port", names.mail, String(p)).split("\n")[0].split(":").pop());
  c.base = `http://127.0.0.1:${hostPort(8081)}`;
  const imapPort = hostPort(3143);
  await until("the mail server", async () => { await appendMessages(imapPort, []); return true; }, 90000, 1000);

  console.log("Starting dmarc-compass ...");
  const startApp = async () => {
    docker("run", "-d", "--name", names.app, "--network", `container:${names.mail}`, "-v", `${names.vol}:/data`,
      "-e", "ADMIN_USER=admin", "-e", `ADMIN_PASSWORD=${PASSWORD}`, "-e", `CONFIG_ENCRYPTION_KEY=${KEY}`,
      "-e", "IMAP_TEST_PORT=3143", "-e", "READ_TIMEOUT_SECONDS=40", "-e", "ALLOW_INSECURE_HTTP=true",
      // GreenMail itself uses 8080 in the shared network namespace.
      "-e", "PORT=8081", image);
    await until("the app to answer /healthz", async () => (await fetch(`${c.base}/healthz`)).ok, 40000);
  };
  await startApp();

  await runScenario({
    imapPort,
    async refusesWithoutSettings() {
      const r = spawnSync("docker", ["run", "--rm", image], { encoding: "utf8" });
      return { ok: r.status === 1 && /no default password/i.test(r.stderr), detail: r.stderr };
    },
    async healthy() {
      return until("Docker health to be healthy", () => docker("inspect", "-f", "{{.State.Health.Status}}", names.app) === "healthy", 90000, 2000).then(() => true, () => false);
    },
    async uid() { return docker("exec", names.app, "id", "-u"); },
    async exec(...a) { return docker("exec", names.app, ...a); },
    async parserEnvNames() { return docker("exec", names.app, "node", "-e", PARSER_ENV_SCRIPT); },
    async backup() {
      docker("exec", names.app, "node", "dist/server.mjs", "--backup", "/data/e2e-backup.db");
      return docker("exec", names.app, "node", "-e", BACKUP_COUNT_SCRIPT);
    },
    async backupAgainStatus() {
      return spawnSync("docker", ["exec", names.app, "node", "dist/server.mjs", "--backup", "/data/e2e-backup.db"], { encoding: "utf8" }).status;
    },
    async resetAdmin() { return docker("exec", names.app, "node", "dist/server.mjs", "--reset-admin"); },
    async restart() {
      const t0 = Date.now();
      docker("stop", "-t", "20", names.app);
      const seconds = (Date.now() - t0) / 1000;
      const exitCode = docker("inspect", "-f", "{{.State.ExitCode}}", names.app);
      docker("start", names.app);
      await until("the app after restart", async () => (await fetch(`${c.base}/healthz`)).ok, 40000);
      return { exitCode, seconds };
    },
  }, c);
}

try {
  await main();
} catch (err) {
  check("test run completed", false, err.stack ?? String(err));
  try { console.log("\n--- app log ---\n" + docker("logs", "--tail", "40", names.app)); } catch { /* not started */ }
} finally {
  if (keep) console.log(`\nKept containers ${names.app} and ${names.mail} (remove with: docker rm -f ${names.app} ${names.mail}; docker volume rm ${names.vol})`);
  else {
    for (const n of [names.app, names.mail]) { try { docker("rm", "-f", n); } catch { /* gone */ } }
    try { docker("volume", "rm", "-f", names.vol); } catch { /* gone */ }
  }
}
process.exit(finish());
