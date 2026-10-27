import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const FILES = [
  "README.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "NOTICE.md",
  "deploy/kubernetes/README.md",
  ...readdirSync(join(root, "docs")).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`),
];
const read = (f: string) => readFileSync(join(root, f), "utf8");

// GitHub's rule for turning a heading into an anchor.
const slug = (h: string) => h.replace(/<[^>]+>/g, "").trim().toLowerCase().replace(/[`*_]/g, "").replace(/[^\w\- ]/g, "").replace(/ /g, "-");
const anchorsOf = (f: string) => new Set(read(f).split("\n").map((l) => l.match(/^#{1,6}\s+(.*)$/)?.[1]).filter((h): h is string => Boolean(h)).map(slug));

test("links between the README and the guides point at files and headings that exist", () => {
  const problems: string[] = [];
  const anchors = new Map(FILES.map((f) => [f, anchorsOf(f)]));
  for (const f of FILES) {
    const text = read(f).replace(/```[\s\S]*?```/g, "");
    for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1];
      if (/^(https?:|mailto:)/.test(target)) continue;
      const [path, frag] = target.split("#");
      const file = path ? normalize(join(dirname(f), path)) : f;
      if (!existsSync(join(root, file))) { problems.push(`${f}: missing file ${target}`); continue; }
      if (frag && anchors.has(file) && !anchors.get(file)!.has(frag)) problems.push(`${f}: missing heading ${target}`);
    }
    for (const m of read(f).matchAll(/<img src="([^"]+)"/g)) {
      if (!/^https?:/.test(m[1]) && !existsSync(join(root, normalize(join(dirname(f), m[1]))))) problems.push(`${f}: missing image ${m[1]}`);
    }
  }
  assert.deepEqual(problems, []);
});

test("the README names every way to run it and points at its guide", () => {
  const readme = read("README.md");
  for (const heading of ["### Cloudflare", "### Docker", "### Kubernetes"]) assert.ok(readme.includes(heading), heading);
  assert.ok(readme.includes("docs/self-hosting.md") && readme.includes("deploy/kubernetes/README.md"));
});

test("every document is reachable from the README", () => {
  const readme = read("README.md");
  const missing = FILES.filter((f) => f !== "README.md" && !readme.includes(f) && f !== "NOTICE.md").filter((f) => !readme.includes(f.replace(/^docs\//, "docs/")));
  assert.deepEqual(missing, []);
});

test("no document speaks in the first person", () => {
  const offenders = FILES.filter((f) => /(^|[\s(*])I (tested|measured|tried|did|have|will|built|think|believe|recommend)\b/m.test(read(f).replace(/```[\s\S]*?```/g, "")));
  assert.deepEqual(offenders, []);
});
