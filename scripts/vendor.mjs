#!/usr/bin/env node
// Copies the browser libraries the dashboard uses out of node_modules into
// public/vendor, which the Worker serves as static assets. They are committed,
// so a fresh clone needs no build step and the pages make no requests to
// third-party CDNs. After bumping a version in package.json, run
// `npm install && npm run vendor` and commit the result.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = join(root, "public", "vendor");
mkdirSync(out, { recursive: true });

const files = [
  ["node_modules/chart.js/dist/chart.umd.min.js", "chart.min.js"],
  ["node_modules/leaflet/dist/leaflet.js", "leaflet.js"],
  ["node_modules/leaflet/dist/leaflet.css", "leaflet.css"],
  ["node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2", "inter-latin-wght-normal.woff2"],
];
for (const [from, to] of files) copyFileSync(join(root, from), join(out, to));

const version = (p) => JSON.parse(readFileSync(join(root, "node_modules", p, "package.json"), "utf8")).version;
writeFileSync(
  join(out, "VERSIONS.txt"),
  `chart.js ${version("chart.js")} (MIT)\nleaflet ${version("leaflet")} (BSD-2-Clause)\n@fontsource-variable/inter ${version("@fontsource-variable/inter")} (font: SIL OFL 1.1)\n`,
);
console.log("vendored:", files.map(([, t]) => t).join(", "));
