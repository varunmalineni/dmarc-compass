import test from "node:test";
import assert from "node:assert/strict";
import { makeBareDb } from "./d1-shim.ts";
import { applyMigrations } from "../src/migrations.ts";
import { effectiveTags, ruleTags, parseImport, parseRules, validateRule, resolveScope, tagCounts, loadFilters, saveRules, type TagData } from "../src/tags.ts";
import { domainFilter, effectiveDomains, parseFilters, recordsByDate, scopeLabel, scopeSlug, withFilters } from "../src/filters.ts";
import { parseExpr, type Group } from "../src/domain-filter.ts";

const expr = (x: unknown): Group => {
  const p = parseExpr(x);
  assert.ok(p.ok && p.expr);
  return p.expr;
};
const data = (manual: Record<string, string[]>, rules: Array<{ tag: string; expr: unknown }> = []): TagData => ({
  manual: new Map(Object.entries(manual).map(([d, t]) => [d, new Set(t)])),
  rules: rules.map((r, i) => ({ id: `r${i}`, tag: r.tag, expr: expr(r.expr) })),
});

// ------------------------------------------------------- rules and tag sets

test("a domain's tags are the ones set by hand plus the ones its name earns from rules", () => {
  const d = data({ "shop.de": ["prod"] }, [{ tag: "emea", expr: { field: "domain", op: "ends", value: ".de" } }]);
  assert.deepEqual([...effectiveTags("shop.de", d)].sort(), ["emea", "prod"]);
  assert.deepEqual([...effectiveTags("shop.fr", d)], []);
  assert.deepEqual([...ruleTags("shop.de", d)], ["emea"], "only the rule's tag is marked as automatic");
  assert.deepEqual([...effectiveTags("anything.de", d)], ["emea"], "a new domain is tagged as soon as it appears");
});

test("rules can be grouped with AND, OR and NOT on the domain name", () => {
  const d = data({}, [{ tag: "eu-shops", expr: { all: [{ any: [{ field: "domain", op: "ends", value: ".de" }, { field: "domain", op: "ends", value: ".fr" }] }, { field: "domain", op: "starts", value: "shop" }] } },
    { tag: "not-internal", expr: { any: [{ field: "domain", op: "ends", value: ".internal" }], not: true } }]);
  assert.deepEqual([...effectiveTags("shop.de", d)].sort(), ["eu-shops", "not-internal"]);
  assert.deepEqual([...effectiveTags("blog.de", d)], ["not-internal"]);
  assert.deepEqual([...effectiveTags("shop.internal", d)], []);
});

test("a rule must name a tag and a domain condition, and may not read tags or policies", () => {
  const ok = validateRule({ tag: "EMEA", expr: { field: "domain", op: "ends", value: ".de" } }, "x");
  assert.ok(ok.ok && ok.rule.tag === "emea");
  const bad = (input: unknown) => { const r = validateRule(input, "x"); assert.equal(r.ok, false); return r.ok ? "" : r.error; };
  assert.match(bad({ tag: "", expr: { field: "domain", op: "ends", value: ".de" } }), /tag name/);
  assert.match(bad({ tag: "x" }), /at least one condition/);
  assert.match(bad({ tag: "x", expr: { all: [] } }), /at least one condition/);
  assert.match(bad({ tag: "x", expr: { field: "tag", op: "has", value: "y" } }), /only look at the domain name/);
  assert.match(bad({ tag: "x", expr: { field: "policy", op: "is", value: "reject" } }), /only look at the domain name/);
  assert.match(bad({ tag: "x", expr: { all: [{ field: "domain", op: "eq", value: "a.com" }, { any: [{ field: "tag", op: "any_tag" }] }] } }), /only look at the domain name/);
  assert.match(bad(null), /tag name/);
});

test("stored rules that are damaged or too many are dropped, not trusted", () => {
  assert.deepEqual(parseRules(null), []);
  assert.deepEqual(parseRules("nope"), []);
  assert.deepEqual(parseRules('{"a":1}'), []);
  const good = { id: "a", tag: "emea", expr: { all: [{ field: "domain", op: "ends", value: ".de" }] } };
  const mixed = parseRules(JSON.stringify([good, { id: "b", tag: "!!", expr: good.expr }, { id: "", tag: "x", expr: good.expr }, { id: "c", tag: "y", expr: { field: "policy", op: "is", value: "none" } }]));
  assert.deepEqual(mixed.map((r) => r.id), ["a"]);
});

// ------------------------------------------------------------------ import

test("pasted text becomes domains with tags, merging repeated domains", () => {
  const r = parseImport("domain,tags\nExample.com, EMEA, prod\nshop.de\temea\nexample.com;team-a\n# comment\n\n");
  assert.deepEqual(r.errors.map((e) => e.line), [3 /* shop.de line has tags */].slice(0, 0));
  assert.deepEqual(r.entries.find((e) => e.domain === "example.com")?.tags, ["emea", "prod", "team-a"]);
  assert.deepEqual(r.entries.find((e) => e.domain === "shop.de")?.tags, ["emea"]);
});

test("import reports each bad line with its number and reason, and keeps the good ones", () => {
  const r = parseImport("good.com, emea\nnot-a-domain, x\nnotags.com\nok.com, Bad Tag!\nfine.org prod");
  assert.deepEqual(r.entries.map((e) => e.domain), ["good.com", "fine.org"]);
  assert.deepEqual(r.errors.map((e) => e.line), [2, 3, 4]);
  assert.match(r.errors[1].reason, /no tags/);
});

test("import limits: lines and tags per domain", () => {
  const many = Array.from({ length: 5002 }, (_, i) => `d${i}.com, t`).join("\n");
  const r = parseImport(many);
  assert.equal(r.entries.length, 5000);
  assert.ok(r.errors.some((e) => /first 5000/.test(e.reason)));
  const tooMany = parseImport(`a.com, ${Array.from({ length: 21 }, (_, i) => `t${i}`).join(", ")}`);
  assert.equal(tooMany.entries.length, 0);
  assert.match(tooMany.errors[0].reason, /more than 20/);
});

// ----------------------------------------------- filters against a database

async function seeded() {
  const db = makeBareDb();
  await applyMigrations(db);
  const raw = (db as any).raw;
  const rep = raw.prepare("INSERT INTO dmarc_reports (hash, report_id, org_name, domain, date_begin, date_end, policy_p, policy_pct, inserted_at) VALUES (?,?,?,?,?,?,?,?,?)");
  const rec = raw.prepare("INSERT INTO dmarc_records (report_hash, source_ip, count, disposition, policy_dkim, policy_spf, header_from, domain, date_begin) VALUES (?,?,?,?,?,?,?,?,?)");
  const domains: Array<[string, string]> = [["shop.de", "reject"], ["shop.fr", "none"], ["blog.com", "quarantine"], ["old.de", "none"], ["new.example", "reject"]];
  domains.forEach(([d, p], i) => {
    rep.run(`h${i}`, `r${i}`, "google.com", d, 100, 200 + i, p, 100, 300);
    rec.run(`h${i}`, "192.0.2.1", 10 * (i + 1), "none", "pass", "pass", d, d, 100);
  });
  raw.prepare("INSERT INTO tls_reports (hash, report_id, org_name, date_begin, date_end, inserted_at) VALUES ('t','t1','google.com',100,200,300)").run();
  raw.prepare("INSERT INTO tls_policy_results (report_hash, policy_domain, policy_type, successful_count, failure_count, date_begin) VALUES ('t','tls-only.com','sts',1,0,100)").run();
  raw.prepare("INSERT INTO domain_tags (domain, tag) VALUES (?,?)").run("shop.de", "prod");
  raw.prepare("INSERT INTO domain_tags (domain, tag) VALUES (?,?)").run("shop.fr", "prod");
  raw.prepare("INSERT INTO domain_tags (domain, tag) VALUES (?,?)").run("blog.com", "team-a");
  raw.prepare("INSERT INTO domain_tags (domain, tag) VALUES (?,?)").run("not-reported.com", "prod");
  await saveRules(db, [{ id: "r1", tag: "emea", expr: expr({ any: [{ field: "domain", op: "ends", value: ".de" }, { field: "domain", op: "ends", value: ".fr" }] }) }]);
  return db;
}

test("a filter resolves to the known domains it matches (reports and TLS), including rule tags and policy", async () => {
  const db = await seeded();
  const scope = (x: unknown) => resolveScope(db, expr(x));
  assert.deepEqual(await scope({ field: "tag", op: "has", value: "prod" }), ["shop.de", "shop.fr"], "a tagged domain with no reports is not listed");
  assert.deepEqual(await scope({ field: "tag", op: "has", value: "emea" }), ["old.de", "shop.de", "shop.fr"], "rule-derived tags count");
  assert.deepEqual(await scope({ all: [{ field: "tag", op: "has", value: "emea" }, { field: "tag", op: "not_has", value: "prod" }] }), ["old.de"]);
  assert.deepEqual(await scope({ any: [{ field: "tag", op: "has", value: "team-a" }, { field: "policy", op: "is", value: "reject" }] }), ["blog.com", "new.example", "shop.de"]);
  assert.deepEqual(await scope({ field: "tag", op: "no_tags" }), ["new.example", "tls-only.com"]);
  assert.deepEqual(await scope({ field: "tag", op: "has", value: "nothing" }), [], "a real answer: no domain has it");
  assert.equal(await resolveScope(db, null), null);
  assert.deepEqual(await scope({ all: [{ field: "domain", op: "contains", value: "shop" }], not: true }), ["blog.com", "new.example", "old.de", "tls-only.com"]);
});

test("the SQL restriction returns exactly the matching domains' rows, and an empty match returns nothing", async () => {
  const db = await seeded();
  const raw = (db as any).raw;
  const sumFor = async (query: string) => {
    const f = await loadFilters(db, new URL(`http://x/?${query}`));
    const dc = domainFilter("r.domain", f);
    return (raw.prepare(`SELECT COALESCE(SUM(r.count),0) AS n, COUNT(DISTINCT r.domain) AS d FROM dmarc_records r WHERE r.date_begin >= 0${dc.sql}`).get(...dc.params)) as { n: number; d: number };
  };
  assert.deepEqual({ ...(await sumFor("")) }, { n: 150, d: 5 }, "no filter: everything");
  assert.deepEqual({ ...(await sumFor("tag=prod")) }, { n: 30, d: 2 }, "shop.de (10) + shop.fr (20)");
  assert.deepEqual({ ...(await sumFor("tag=emea")) }, { n: 70, d: 3 }, "adds old.de (40)");
  assert.deepEqual({ ...(await sumFor("tag=nothing")) }, { n: 0, d: 0 }, "matches nothing, and does not fall back to everything");
  assert.deepEqual({ ...(await sumFor("tag=prod&domains=shop.de,blog.com")) }, { n: 10, d: 1 }, "selected domains AND the filter");
  const rejectOrTeamA = encodeURIComponent(JSON.stringify({ any: [{ field: "policy", op: "is", value: "reject" }, { field: "tag", op: "has", value: "team-a" }] }));
  assert.deepEqual({ ...(await sumFor(`f=${rejectOrTeamA}`)) }, { n: 90, d: 3 }, "shop.de (10) + blog.com (30) + new.example (50)");
});

test("a filter that was never resolved matches nothing instead of everything", () => {
  const f = parseFilters(new URL("http://x/?tag=prod"));
  assert.equal(f.scope, null);
  assert.deepEqual(effectiveDomains(f), []);
  assert.match(domainFilter("r.domain", f).sql, /json_each/);
  assert.equal(domainFilter("r.domain", f).params[0], "[]");
});

test("the date-index hint is only used when nothing narrows the domains", () => {
  assert.equal(recordsByDate(parseFilters(new URL("http://x/"))), " INDEXED BY idx_records_date");
  assert.equal(recordsByDate(parseFilters(new URL("http://x/?tag=prod"))), "");
  assert.equal(recordsByDate(parseFilters(new URL("http://x/?domains=a.com"))), "");
});

test("the URL forms: tag= shortcut, f= full filter, both together, junk ignored", () => {
  assert.deepEqual(parseFilters(new URL("http://x/?tag=EMEA")).expr, { mode: "all", items: [{ field: "tag", op: "has", value: "emea" }] });
  assert.deepEqual(parseFilters(new URL("http://x/?tag=emea,prod")).expr?.items[0], { field: "tag", op: "has_any", value: ["emea", "prod"] });
  const both = parseFilters(new URL(`http://x/?tag=prod&f=${encodeURIComponent(JSON.stringify({ field: "domain", op: "ends", value: ".de" }))}`));
  assert.equal(both.expr?.mode, "all");
  assert.equal(both.expr?.items.length, 2);
  assert.equal(parseFilters(new URL("http://x/?f=%7Bnot%20json")).expr, null);
  assert.equal(parseFilters(new URL("http://x/?tag=!!,,")).expr, null);
});

test("links keep the filter, and the label says what is being shown", async () => {
  const db = await seeded();
  const f = await loadFilters(db, new URL("http://x/?tag=emea&range=30"));
  const link = withFilters("/domains", f);
  assert.match(link, /^\/domains\?f=/);
  assert.deepEqual(parseFilters(new URL("http://x" + link)).expr, f.expr);
  assert.equal(scopeLabel(f), "has tag emea (3 domains)");
  assert.equal(scopeLabel(await loadFilters(db, new URL("http://x/"))), "All domains");
  assert.equal(scopeLabel(await loadFilters(db, new URL("http://x/?domains=a.com,b.com&tag=prod"))), "2 domains · has tag prod (2 domains)");
  assert.equal(scopeSlug(f), "filtered");
});

test("tag counts include automatic tags, and tags on domains that have not reported yet", async () => {
  const db = await seeded();
  const counts = Object.fromEntries((await tagCounts(db)).map((t) => [t.tag, { count: t.count, byRule: t.byRule }]));
  assert.deepEqual(counts, { emea: { count: 3, byRule: 3 }, prod: { count: 2, byRule: 0 }, "team-a": { count: 1, byRule: 0 } });
});

// ------------------------------------------------------------------ colours

import { TAG_COLORS, autoColor, colorOf, parseColors, isTagColor } from "../src/tags.ts";

test("a tag's automatic colour comes from its name: always the same, always from the palette, and spread out", () => {
  for (const t of ["emea", "prod", "team-a", "x", "a".repeat(32)]) {
    assert.equal(autoColor(t), autoColor(t));
    assert.ok(TAG_COLORS.includes(autoColor(t)));
  }
  const used = new Set(Array.from({ length: 60 }, (_, i) => autoColor(`tag-${i}`)));
  assert.ok(used.size >= 8, `60 different names used only ${used.size} of ${TAG_COLORS.length} colours`);
});

test("a chosen colour wins over the automatic one; junk falls back", () => {
  assert.equal(colorOf("emea", { emea: "pink" }), "pink");
  assert.equal(colorOf("emea", {}), autoColor("emea"));
  assert.equal(colorOf("emea", { emea: "hotpink" }), autoColor("emea"));
  assert.ok(isTagColor("teal") && !isTagColor("teal ") && !isTagColor(5));
});

test("stored colours that are damaged are ignored", () => {
  assert.deepEqual(parseColors(null), {});
  assert.deepEqual(parseColors("nope"), {});
  assert.deepEqual(parseColors("[1,2]"), {});
  assert.deepEqual(parseColors('{"emea":"blue","Bad Tag":"red","prod":"nonsense"}'), { emea: "blue" });
});
