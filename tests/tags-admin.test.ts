import test from "node:test";
import assert from "node:assert/strict";
import { makeBareDb } from "./d1-shim.ts";
import { applyMigrations } from "../src/migrations.ts";
import { tagsAction, tagsExportRows, PAGE_SIZE } from "../src/tags-admin.ts";
import { loadTagData } from "../src/tags.ts";

async function setup(domains: string[] = ["shop.de", "shop.fr", "blog.com", "old.de", "new.example"]) {
  const db = makeBareDb();
  await applyMigrations(db);
  const raw = (db as any).raw;
  const rep = raw.prepare("INSERT INTO dmarc_reports (hash, report_id, org_name, domain, date_begin, date_end, policy_p, policy_pct, inserted_at) VALUES (?,?,?,?,?,?,?,?,?)");
  domains.forEach((d, i) => rep.run(`h${i}`, `r${i}`, "google.com", d, 100, 200, "none", 100, 300));
  const act = async (action: string, body: Record<string, unknown> = {}) => (await tagsAction(db, action, body))!;
  const tagsOf = async (d: string) => [...((await loadTagData(db)).manual.get(d) ?? [])].sort();
  return { db, raw, act, tagsOf };
}

test("add a tag to chosen domains, then remove it from one", async () => {
  const { act, tagsOf } = await setup();
  const r = await act("tags_apply", { domains: ["shop.de", "shop.fr"], add: ["EMEA", "prod"] });
  assert.equal(r.status, 200);
  assert.deepEqual(await tagsOf("shop.de"), ["emea", "prod"]);
  assert.deepEqual(await tagsOf("blog.com"), []);
  await act("tags_apply", { domains: ["shop.fr"], remove: ["prod"] });
  assert.deepEqual(await tagsOf("shop.fr"), ["emea"]);
  assert.deepEqual(await tagsOf("shop.de"), ["emea", "prod"], "others untouched");
});

test("a tag can be added to every domain that matches a search, not just the visible page", async () => {
  const { act, tagsOf } = await setup();
  const r = await act("tags_apply", { match: { q: ".de" }, add: ["germany"] });
  assert.equal((r.body as any).domains, 2);
  assert.deepEqual(await tagsOf("shop.de"), ["germany"]);
  assert.deepEqual(await tagsOf("old.de"), ["germany"]);
  assert.deepEqual(await tagsOf("shop.fr"), []);
  const untagged = await act("tags_apply", { match: { untagged: true }, add: ["review"] });
  assert.equal((untagged.body as any).domains, 3, "shop.fr, blog.com, new.example");
});

test("bad requests are refused with a reason", async () => {
  const { act } = await setup();
  assert.match(((await act("tags_apply", { domains: ["a.com"] })).body as any).error, /Choose a tag/);
  assert.match(((await act("tags_apply", { domains: ["a.com"], add: ["x"], remove: ["x"] })).body as any).error, /both added and removed/);
  assert.match(((await act("tags_apply", { domains: [], add: ["x"] })).body as any).error, /No domains/);
  assert.match(((await act("tags_apply", { match: { q: "zzz-none" }, add: ["x"] })).body as any).error, /No domains/);
  assert.equal((await act("tags_apply", { domains: ["a.com"], add: ["Bad Tag!!"] })).status, 400, "an invalid tag is dropped, leaving nothing to do");
});

test("a domain keeps to 20 tags by hand and is reported when it is full", async () => {
  const { act, tagsOf } = await setup();
  for (let i = 0; i < 20; i++) await act("tags_apply", { domains: ["shop.de"], add: [`t${i}`] });
  const r = await act("tags_apply", { domains: ["shop.de", "blog.com"], add: ["one-more"] });
  assert.equal((r.body as any).skippedCount, 1);
  assert.deepEqual((r.body as any).skippedFull, ["shop.de"]);
  assert.equal((await tagsOf("shop.de")).length, 20);
  assert.deepEqual(await tagsOf("blog.com"), ["one-more"], "the others still got it");
});

test("there can be at most 200 different tags", async () => {
  const { act } = await setup();
  for (let i = 0; i < 200; i++) await act("tags_apply", { domains: [`d${i}.com`], add: [`tag${i}`] });
  const r = await act("tags_apply", { domains: ["shop.de"], add: ["one-too-many"] });
  assert.equal(r.status, 400);
  assert.match((r.body as any).error, /at most 200/);
  assert.equal((await act("tags_apply", { domains: ["shop.de"], add: ["tag5"] })).status, 200, "an existing tag is fine");
});

test("removing a tag a rule gives is explained, not silently ignored", async () => {
  const { act, tagsOf } = await setup();
  await act("tag_rule_save", { tag: "emea", expr: { field: "domain", op: "ends", value: ".de" } });
  await act("tags_apply", { domains: ["shop.de"], add: ["emea"] });
  const r = await act("tags_apply", { domains: ["shop.de", "old.de"], remove: ["emea"] });
  assert.equal((r.body as any).removedRows, 1);
  assert.equal((r.body as any).keptByRule, 2, "both still match the rule");
  assert.deepEqual(await tagsOf("shop.de"), []);
});

test("the domain list: search, filter by tag, untagged, pages, and which tags come from rules", async () => {
  const { act } = await setup(Array.from({ length: 120 }, (_, i) => `d${String(i).padStart(3, "0")}.com`));
  await act("tags_apply", { domains: ["d005.com"], add: ["prod"] });
  await act("tag_rule_save", { tag: "five", expr: { field: "domain", op: "starts", value: "d00" } });
  const all = (await act("tags_list", {})).body as any;
  assert.equal(all.total, 120);
  assert.equal(all.rows.length, PAGE_SIZE);
  const p3 = (await act("tags_list", { page: 3 })).body as any;
  assert.equal(p3.rows.length, 20);
  const d5 = ((await act("tags_list", { q: "d005" })).body as any).rows[0];
  assert.deepEqual(d5.tags, [{ tag: "five", rule: true }, { tag: "prod", rule: false }]);
  assert.equal(((await act("tags_list", { tag: "prod" })).body as any).total, 1);
  assert.equal(((await act("tags_list", { untagged: true })).body as any).total, 110, "d000 to d009 match the rule");
  assert.equal(((await act("tags_list", { q: "prod" })).body as any).total, 1, "the search also finds tags");
});

test("import: preview first, then add; 'set' replaces the tags of the listed domains only", async () => {
  const { act, tagsOf } = await setup();
  await act("tags_apply", { domains: ["shop.de", "blog.com"], add: ["old-tag"] });
  const text = "domain,tags\nshop.de, emea, prod\nnot-a-domain, x\nnew.example emea";
  const preview = (await act("tags_import", { text, dryRun: true })).body as any;
  assert.deepEqual([preview.domains, preview.tags, preview.errorCount, preview.dryRun], [2, 2, 1, true]);
  assert.deepEqual(await tagsOf("new.example"), [], "a preview changes nothing");

  const added = (await act("tags_import", { text, mode: "add" })).body as any;
  assert.equal(added.applied, true);
  assert.deepEqual(await tagsOf("shop.de"), ["emea", "old-tag", "prod"]);
  assert.deepEqual(await tagsOf("new.example"), ["emea"]);

  await act("tags_import", { text: "shop.de, only-this", mode: "set" });
  assert.deepEqual(await tagsOf("shop.de"), ["only-this"], "replaced");
  assert.deepEqual(await tagsOf("blog.com"), ["old-tag"], "a domain not listed is untouched");
  assert.equal((await act("tags_import", { text: "junk\nmore junk" })).status, 400);
});

test("renaming a tag moves it everywhere, and merges with an existing one", async () => {
  const { act, tagsOf } = await setup();
  await act("tags_apply", { domains: ["shop.de", "shop.fr"], add: ["emea"] });
  await act("tags_apply", { domains: ["shop.fr", "blog.com"], add: ["europe"] });
  await act("tag_rule_save", { tag: "emea", expr: { field: "domain", op: "ends", value: ".de" } });
  const r = await act("tags_rename", { from: "emea", to: "europe" });
  assert.equal((r.body as any).merged, true);
  assert.deepEqual(await tagsOf("shop.de"), ["europe"]);
  assert.deepEqual(await tagsOf("shop.fr"), ["europe"], "one row, not two");
  assert.deepEqual(await tagsOf("blog.com"), ["europe"]);
  const o = (await act("tags_overview")).body as any;
  assert.equal(o.rules[0].tag, "europe", "the rule follows the rename");
  assert.equal((await act("tags_rename", { from: "nope", to: "x" })).status, 404);
  assert.match(((await act("tags_rename", { from: "europe", to: "Bad Name!" })).body as any).error, /new name/);
});

test("deleting a tag removes it from every domain and drops the rules that gave it", async () => {
  const { act, tagsOf } = await setup();
  await act("tags_apply", { domains: ["shop.de", "blog.com"], add: ["temp", "keep"] });
  await act("tag_rule_save", { tag: "temp", expr: { field: "domain", op: "ends", value: ".fr" } });
  const r = (await act("tags_delete", { tag: "temp" })).body as any;
  assert.deepEqual([r.removedFrom, r.rulesRemoved], [2, 1]);
  assert.deepEqual(await tagsOf("shop.de"), ["keep"]);
  assert.equal(((await act("tags_overview")).body as any).rules.length, 0);
});

test("rules: preview, save, edit, delete, and what they may contain", async () => {
  const { act } = await setup();
  const expr = { any: [{ field: "domain", op: "ends", value: ".de" }, { field: "domain", op: "ends", value: ".fr" }] };
  const p = (await act("tag_rule_preview", { expr })).body as any;
  assert.equal(p.matches, 3);
  assert.deepEqual([...p.sample].sort(), ["old.de", "shop.de", "shop.fr"]);
  const saved = (await act("tag_rule_save", { tag: "emea", expr })).body as any;
  assert.match(saved.id, /^[0-9a-f]{12}$/);
  await act("tag_rule_save", { id: saved.id, tag: "emea", expr: { field: "domain", op: "ends", value: ".de" } });
  let o = (await act("tags_overview")).body as any;
  assert.deepEqual([o.rules.length, o.rules[0].matches, o.rules[0].text], [1, 2, "domain ends with .de"]);
  assert.match(((await act("tag_rule_save", { tag: "x", expr: { field: "tag", op: "has", value: "y" } })).body as any).error, /only look at the domain name/);
  assert.match(((await act("tag_rule_save", { tag: "x" })).body as any).error, /at least one condition/);
  assert.equal((await act("tag_rule_delete", { id: saved.id })).status, 200);
  assert.equal((await act("tag_rule_delete", { id: saved.id })).status, 404);
  o = (await act("tags_overview")).body as any;
  assert.equal(o.rules.length, 0);
});

test("there can be at most 50 rules", async () => {
  const { act } = await setup();
  for (let i = 0; i < 50; i++) assert.equal((await act("tag_rule_save", { tag: `r${i}`, expr: { field: "domain", op: "eq", value: `d${i}.com` } })).status, 200);
  assert.match(((await act("tag_rule_save", { tag: "extra", expr: { field: "domain", op: "eq", value: "x.com" } })).body as any).error, /at most 50/);
});

test("the export lists every domain with its own tags and its rule tags apart", async () => {
  const { act, db } = await setup();
  await act("tags_apply", { domains: ["shop.de"], add: ["prod"] });
  await act("tag_rule_save", { tag: "emea", expr: { field: "domain", op: "ends", value: ".de" } });
  await act("tags_apply", { domains: ["tagged-only.com"], add: ["early"] });
  const rows = await tagsExportRows(db);
  assert.deepEqual(rows.find((r) => r[0] === "shop.de"), ["shop.de", "prod", "emea"]);
  assert.deepEqual(rows.find((r) => r[0] === "tagged-only.com"), ["tagged-only.com", "early", ""], "included before it has reported");
  assert.deepEqual(rows.find((r) => r[0] === "blog.com"), ["blog.com", "", ""]);
});

test("unknown actions are not handled", async () => {
  const { db } = await setup();
  assert.equal(await tagsAction(db, "tags_unknown", {}), null);
});

// ------------------------------------------------------------------ colours

async function colorsOf(act: (action: string, body?: Record<string, unknown>) => Promise<any>): Promise<Record<string, string>> {
  const body = (await act("tags_overview")).body as any;
  const out: Record<string, string> = {};
  for (const t of body.tags) out[t.tag] = t.color;
  return out;
}

test("a new tag gets a colour at once, and the first ten tags all get different ones", async () => {
  const { act } = await setup();
  for (let i = 0; i < 10; i++) await act("tags_apply", { domains: ["shop.de"], add: [`tag${i}`] });
  const c = await colorsOf(act);
  assert.equal(Object.keys(c).length, 10);
  assert.equal(new Set(Object.values(c)).size, 10, JSON.stringify(c));
  await act("tags_apply", { domains: ["shop.de"], add: ["eleventh"] });
  assert.ok(((await act("tags_overview")).body as any).palette.includes((await colorsOf(act)).eleventh), "after ten, colours repeat");
});

test("tags made by an import or a rule are coloured too, and an existing tag keeps its colour", async () => {
  const { act } = await setup();
  await act("tags_import", { text: "shop.de, a, b\nblog.com, c", mode: "add" });
  await act("tag_rule_save", { tag: "d", expr: { field: "domain", op: "ends", value: ".fr" } });
  const c = await colorsOf(act);
  assert.deepEqual(Object.keys(c).sort(), ["a", "b", "c", "d"]);
  assert.equal(new Set(Object.values(c)).size, 4);
  await act("tags_apply", { domains: ["old.de"], add: ["a"] });
  assert.equal((await colorsOf(act)).a, c.a, "adding an existing tag to another domain changes nothing");
});

test("choose a colour for a tag, and ask for a fresh pick", async () => {
  const { act } = await setup();
  await act("tags_apply", { domains: ["shop.de"], add: ["emea"] });
  await act("tags_apply", { domains: ["shop.fr"], add: ["other"] });
  const before = await colorsOf(act);
  const pick = before.emea === "blue" ? "pink" : "blue";
  assert.equal((await act("tag_color", { tag: "emea", color: pick })).status, 200);
  assert.equal((await colorsOf(act)).emea, pick);
  const reset = (await act("tag_color", { tag: "emea", color: "" })).body as any;
  assert.notEqual(reset.color, (await colorsOf(act)).other, "'pick one for me' avoids the colour the other tag has");
  assert.equal((await colorsOf(act)).emea, reset.color);
});

test("colours are refused when they are not on offer or the tag does not exist", async () => {
  const { act } = await setup();
  await act("tags_apply", { domains: ["shop.de"], add: ["emea"] });
  assert.match(((await act("tag_color", { tag: "emea", color: "#ff0000" })).body as any).error, /one of the colours/);
  assert.match(((await act("tag_color", { tag: "emea", color: "<script>" })).body as any).error, /one of the colours/);
  assert.equal((await act("tag_color", { tag: "nothing", color: "red" })).status, 404);
  assert.equal((await act("tag_color", { tag: "Bad Tag!", color: "red" })).status, 400);
});

test("a colour follows a tag when it is renamed, is kept by the one it merges into, and is dropped on delete", async () => {
  const { act } = await setup();
  await act("tags_apply", { domains: ["shop.de"], add: ["old"] });
  await act("tags_apply", { domains: ["shop.fr"], add: ["keep"] });
  await act("tag_color", { tag: "old", color: "red" });
  await act("tags_rename", { from: "old", to: "new" });
  assert.equal((await colorsOf(act)).new, "red");

  await act("tag_color", { tag: "keep", color: "green" });
  await act("tags_rename", { from: "new", to: "keep" });
  assert.equal((await colorsOf(act)).keep, "green", "the tag it merged into keeps its own colour");

  await act("tags_delete", { tag: "keep" });
  await act("tags_apply", { domains: ["shop.de"], add: ["keep"] });
  assert.notEqual((await colorsOf(act)).keep, "green", "a new tag with an old name does not inherit its colour");
});
