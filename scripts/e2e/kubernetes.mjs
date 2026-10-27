#!/usr/bin/env node
// End-to-end test of the Kubernetes manifests, with the real parser and a real IMAP server.
//
//   npm run e2e:k8s                       builds the image, uses the current kubectl context
//   npm run e2e:k8s -- --no-build --image my-image:tag --kind kind --keep
//
// 1. The default manifests (deploy/kubernetes) are applied into the "dmarc-compass" namespace,
//    which enforces the "restricted" Pod Security profile, and must become ready.
// 2. The test overlay (deploy/kubernetes-e2e) adds a throwaway IMAP server to the pod, and the
//    same scenario as the Docker test runs through a port-forward, including killing the
//    container and replacing the pod to check the volume keeps the data.
//
// Needs a cluster whose nodes can see the image: Docker Desktop, OrbStack, or kind (--kind NAME
// loads the image into it). Everything it creates is removed afterwards.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { KEY, PASSWORD, BACKUP_COUNT_SCRIPT, PARSER_ENV_SCRIPT, check, createClient, finish, runScenario, sleep, until } from "./lib.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const image = opt("--image", "dmarc-compass:e2e");
const kindCluster = opt("--kind", null);
const build = !args.includes("--no-build");
const keep = args.includes("--keep");
const BASE_NS = "dmarc-compass";
const NS = "dmarc-compass-e2e";

const sh = (cmd, ...a) => execFileSync(cmd, a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const kubectl = (...a) => sh("kubectl", ...a);
const inNs = (ns, ...a) => kubectl("-n", ns, ...a);

const freePort = () => new Promise((resolve) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const podOf = (ns) => inNs(ns, "get", "pod", "-l", "app.kubernetes.io/name=dmarc-compass", "-o", "jsonpath={.items[0].metadata.name}");
const ready = (ns) => inNs(ns, "get", "pod", "-l", "app.kubernetes.io/name=dmarc-compass", "-o", "jsonpath={.items[0].status.conditions[?(@.type==\"Ready\")].status}") === "True";

let forwarder = null;
async function forward(ns, remotePorts) {
  forwarder?.kill();
  const locals = await Promise.all(remotePorts.map(() => freePort()));
  const p = spawn("kubectl", ["-n", ns, "port-forward", `pod/${podOf(ns)}`, ...remotePorts.map((r, i) => `${locals[i]}:${r}`)], { stdio: ["ignore", "pipe", "pipe"] });
  forwarder = p;
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("port-forward did not start")), 20000);
    p.stdout.on("data", (d) => { if (String(d).includes("Forwarding from")) { clearTimeout(t); resolve(); } });
    p.on("exit", () => { clearTimeout(t); reject(new Error("port-forward exited")); });
  });
  return locals;
}

async function baseManifestsAreAdmitted() {
  console.log("Applying the default manifests into a namespace that enforces the restricted Pod Security profile ...");
  kubectl("apply", "-k", join(root, "deploy/kubernetes"));
  // The pod cannot start until its secret exists; creating it afterwards proves the message is recoverable.
  inNs(BASE_NS, "create", "secret", "generic", "dmarc-compass-secrets", "--from-literal=ADMIN_USER=admin", `--from-literal=ADMIN_PASSWORD=${PASSWORD}`, `--from-literal=CONFIG_ENCRYPTION_KEY=${KEY}`);
  inNs(BASE_NS, "set", "image", "deployment/dmarc-compass", `dmarc-compass=${image}`);
  let ok = true;
  let detail = "";
  try {
    inNs(BASE_NS, "rollout", "status", "deployment/dmarc-compass", "--timeout=180s");
  } catch (e) {
    ok = false;
    detail = String(e.stderr || e.message) + inNs(BASE_NS, "get", "events", "--sort-by=.lastTimestamp").split("\n").slice(-8).join("\n");
  }
  check("the default manifests are admitted under the restricted profile and the pod becomes ready", ok, detail);
  if (ok) {
    const [port] = await forward(BASE_NS, [8080]);
    check("and answers /healthz", (await fetch(`http://127.0.0.1:${port}/healthz`)).ok);
    const fs = inNs(BASE_NS, "exec", "deploy/dmarc-compass", "--", "sh", "-c", "touch /app/x 2>&1; touch /data/ok && echo data-writable");
    check("the root filesystem is read-only and the data volume is writable", /Read-only file system/.test(fs) && /data-writable/.test(fs), fs);
    check("the Service selects the pod", inNs(BASE_NS, "get", "endpoints", "dmarc-compass", "-o", "jsonpath={.subsets[0].addresses[0].ip}") !== "");
    forwarder?.kill();
  }
  kubectl("delete", "-k", join(root, "deploy/kubernetes"), "--wait=true", "--timeout=120s");
}

async function main() {
  const c = createClient();
  if (build) {
    console.log(`Building ${image} ...`);
    sh("docker", "build", "-q", "-f", join(root, "deploy/docker/Dockerfile"), "-t", image, root);
  }
  if (kindCluster) sh("kind", "load", "docker-image", image, "--name", kindCluster);
  for (const ns of [BASE_NS, NS]) kubectl("delete", "namespace", ns, "--ignore-not-found", "--wait=true", "--timeout=120s");

  await baseManifestsAreAdmitted();

  console.log("Applying the test overlay (app + throwaway IMAP server in one pod) ...");
  kubectl("apply", "-k", join(root, "deploy/kubernetes-e2e"));
  if (image !== "dmarc-compass:e2e") inNs(NS, "set", "image", "deployment/dmarc-compass", `dmarc-compass=${image}`);
  inNs(NS, "rollout", "status", "deployment/dmarc-compass", "--timeout=240s");

  let imapPort = 0;
  const connectForwards = async () => {
    const [http, imap] = await forward(NS, [8080, 3143]);
    c.base = `http://127.0.0.1:${http}`;
    imapPort = imap;
    await until("the app to answer /healthz", async () => (await fetch(`${c.base}/healthz`)).ok, 40000);
  };
  await connectForwards();

  const exec = (...a) => inNs(NS, "exec", podOf(NS), "-c", "dmarc-compass", "--", ...a);
  await runScenario({
    get imapPort() { return imapPort; },
    async refusesWithoutSettings() {
      kubectl("-n", NS, "run", "refuse", `--image=${image}`, "--image-pull-policy=IfNotPresent", "--restart=Never");
      let phase = "";
      await until("the bare pod to stop", () => ["Failed", "Succeeded"].includes((phase = inNs(NS, "get", "pod", "refuse", "-o", "jsonpath={.status.phase}"))), 60000, 1000);
      const logs = inNs(NS, "logs", "refuse");
      inNs(NS, "delete", "pod", "refuse", "--wait=false");
      return { ok: phase === "Failed" && /no default password/i.test(logs), detail: `${phase}: ${logs}` };
    },
    async healthy() { return ready(NS); },
    async uid() { return exec("id", "-u"); },
    async exec(...a) { return exec(...a); },
    async parserEnvNames() { return exec("node", "-e", PARSER_ENV_SCRIPT); },
    async backup() {
      exec("node", "dist/server.mjs", "--backup", "/data/e2e-backup.db");
      return exec("node", "-e", BACKUP_COUNT_SCRIPT);
    },
    async backupAgainStatus() {
      const r = spawnSync("kubectl", ["-n", NS, "exec", podOf(NS), "-c", "dmarc-compass", "--", "node", "dist/server.mjs", "--backup", "/data/e2e-backup.db"], { encoding: "utf8" });
      return /already exists/.test(r.stderr + r.stdout) ? 2 : r.status;
    },
    async resetAdmin() { return exec("node", "dist/server.mjs", "--reset-admin"); },
    async restart() {
      // 1. Stop the server inside the pod the way Kubernetes would on a node drain: SIGTERM to the main process.
      const pod = podOf(NS);
      const before = Number(inNs(NS, "get", "pod", pod, "-o", "jsonpath={.status.containerStatuses[?(@.name==\"dmarc-compass\")].restartCount}"));
      const sentAt = Date.now();
      exec("node", "-e", "process.kill(1,'SIGTERM')");
      await until("the container to be restarted", () => Number(inNs(NS, "get", "pod", pod, "-o", "jsonpath={.status.containerStatuses[?(@.name==\"dmarc-compass\")].restartCount}")) > before, 60000, 500);
      const term = JSON.parse(inNs(NS, "get", "pod", pod, "-o", "jsonpath={.status.containerStatuses[?(@.name==\"dmarc-compass\")].lastState.terminated}"));
      const seconds = Math.max(0, (Date.parse(term.finishedAt) - sentAt) / 1000);
      await until("the pod to be ready again", () => ready(NS), 90000, 1000);
      // 2. Replace the whole pod: the volume must carry the data to the new one.
      inNs(NS, "delete", "pod", pod, "--wait=true", "--timeout=60s");
      await until("a new pod", () => podOf(NS) !== pod && ready(NS), 120000, 1000);
      await connectForwards();
      return { exitCode: String(term.exitCode), seconds };
    },
  }, c);
}

try {
  await main();
} catch (err) {
  check("test run completed", false, err.stack ?? String(err));
  try { console.log("\n--- app log ---\n" + inNs(NS, "logs", "deploy/dmarc-compass", "-c", "dmarc-compass", "--tail=40")); } catch { /* not started */ }
} finally {
  forwarder?.kill();
  if (keep) console.log(`\nKept namespaces ${BASE_NS} and ${NS} (remove with: kubectl delete namespace ${NS})`);
  else for (const ns of [BASE_NS, NS]) { try { kubectl("delete", "namespace", ns, "--ignore-not-found", "--wait=false"); } catch { /* gone */ } }
}
process.exit(finish());
