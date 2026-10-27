import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (p: string) => readFileSync(fileURLToPath(new URL(`../${p}`, import.meta.url)), "utf8");
const PARSER = /ghcr\.io\/cry-inc\/dmarc-report-viewer:([0-9][^\s]*)/;

test("the Cloudflare and the self-hosted images use the same parser version", () => {
  const cloudflare = read("Dockerfile").match(PARSER)?.[1];
  const selfHosted = read("deploy/docker/Dockerfile").match(PARSER)?.[1];
  assert.ok(cloudflare && selfHosted, "both pin a parser version");
  assert.equal(selfHosted, cloudflare);
});

test("nothing personal or secret can end up in the image", () => {
  const ignore = read(".dockerignore").split("\n").map((l) => l.trim());
  for (const pattern of ["wrangler.local.*", ".env", ".env.*", ".git", "node_modules"]) assert.ok(ignore.includes(pattern), `.dockerignore lists ${pattern}`);
  assert.ok(ignore.indexOf("!.env.example") > ignore.indexOf(".env.*"), "only the example file is let back in");
  const dockerfile = read("deploy/docker/Dockerfile");
  assert.ok(!/^\s*(ENV|ARG)\s+(ADMIN_PASSWORD|CONFIG_ENCRYPTION_KEY)/m.test(dockerfile), "no secrets baked into the image");
  assert.match(dockerfile, /^USER node$/m, "runs unprivileged");
});

test("Compose refuses to start without the three required settings and has no default password", () => {
  const compose = read("compose.yaml");
  for (const key of ["ADMIN_USER", "ADMIN_PASSWORD", "CONFIG_ENCRYPTION_KEY"]) assert.match(compose, new RegExp(`${key}: \\$\\{${key}:\\?`), key);
  assert.match(compose, /127\.0\.0\.1:8080:8080/, "bound to this computer only by default");
  assert.match(compose, /ALLOW_INSECURE_HTTP: \$\{ALLOW_INSECURE_HTTP:-false\}/, "plain HTTP is off by default");
  const example = read(".env.example");
  assert.match(example, /^ADMIN_PASSWORD=$/m, "the example ships no password");
  assert.match(example, /^CONFIG_ENCRYPTION_KEY=$/m, "and no key");
});

// ---------------------------------------------------------------- Kubernetes

test("the Kubernetes manifests keep the pod single, unprivileged and read-only", () => {
  const d = read("deploy/kubernetes/deployment.yaml");
  assert.match(d, /replicas: 1\b/);
  assert.match(d, /type: Recreate/, "two pods must never open the database volume at once");
  for (const rule of [/runAsNonRoot: true/, /allowPrivilegeEscalation: false/, /readOnlyRootFilesystem: true/, /drop: \["ALL"\]/, /type: RuntimeDefault/, /automountServiceAccountToken: false/]) assert.match(d, rule);
  for (const probe of ["startupProbe", "readinessProbe", "livenessProbe"]) assert.match(d, new RegExp(`${probe}:\\n\\s+httpGet: \\{ path: /healthz`), probe);
  assert.match(d, /secretRef:\n\s+name: dmarc-compass-secrets/, "the secret is required, and nothing secret is in the manifest");
  assert.ok(!/ADMIN_PASSWORD|CONFIG_ENCRYPTION_KEY/.test(d.replace(/^\s*#.*$/gm, "")), "no secret values or names inlined (comments aside)");
  assert.match(read("deploy/kubernetes/namespace.yaml"), /pod-security\.kubernetes\.io\/enforce: restricted/);
});

test("the default install contains no secret and no test settings; the test overlay is kept apart", () => {
  const k = read("deploy/kubernetes/kustomization.yaml");
  assert.ok(!/kind: Secret|secretGenerator/.test(k), "the secret is created by the person installing");
  assert.ok(!/greenmail|IMAP_TEST_PORT|e2e/i.test(k));
  const config = read("deploy/kubernetes/config.env");
  assert.match(config, /^ALLOW_INSECURE_HTTP=false$/m);
  assert.match(config, /^TRUST_PROXY=false$/m);
  const overlay = read("deploy/kubernetes-e2e/kustomization.yaml");
  assert.match(overlay, /never use this to run\s+# for real|Never use this to run/i, "the overlay says it is for tests only");
});

test("the test overlay's key and password are the ones the test scripts use", async () => {
  const lib = read("scripts/e2e/lib.mjs");
  const overlay = read("deploy/kubernetes-e2e/kustomization.yaml");
  const key = Buffer.alloc(32, 9).toString("base64");
  assert.ok(overlay.includes(`CONFIG_ENCRYPTION_KEY=${key}`));
  const password = lib.match(/PASSWORD = "([^"]+)"/)?.[1];
  assert.ok(password && overlay.includes(`ADMIN_PASSWORD=${password}`));
});
