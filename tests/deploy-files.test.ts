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
