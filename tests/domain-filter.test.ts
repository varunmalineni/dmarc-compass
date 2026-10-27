import test from "node:test";
import assert from "node:assert/strict";
import { parseExpr, evaluate, describe, encodeExpr, decodeExpr, normalizeTag, normalizeDomain, fieldsUsed, tagFilter, MAX_NODES, MAX_DEPTH, type Group, type DomainFacts } from "../src/domain-filter.ts";

const facts = (domain: string, tags: string[] = [], policy: string | null = "none"): DomainFacts => ({ domain, tags: new Set(tags), policy });
const must = (input: unknown): Group => {
  const p = parseExpr(input);
  assert.ok(p.ok, p.ok ? "" : p.error);
  assert.ok(p.expr);
  return p.expr;
};
const matchesFor = (expr: unknown, d: DomainFacts) => evaluate(must(expr), d);
const err = (input: unknown) => { const p = parseExpr(input); assert.equal(p.ok, false, JSON.stringify(input)); return p.ok ? "" : p.error; };

test("a single condition, with or without a wrapping group", () => {
  const c = { field: "tag", op: "has", value: "emea" };
  assert.equal(matchesFor(c, facts("a.example", ["emea"])), true);
  assert.equal(matchesFor({ all: [c] }, facts("a.example", ["apac"])), false);
  assert.deepEqual(must(c), { mode: "all", items: [{ field: "tag", op: "has", value: "emea" }] });
});

test("AND needs every item, OR needs one, NOT inverts a group", () => {
  const emea = { field: "tag", op: "has", value: "emea" };
  const de = { field: "domain", op: "ends", value: ".de" };
  const d1 = facts("shop.de", ["emea"]);
  const d2 = facts("shop.fr", ["emea"]);
  const d3 = facts("shop.de", []);
  assert.deepEqual([d1, d2, d3].map((d) => matchesFor({ all: [emea, de] }, d)), [true, false, false]);
  assert.deepEqual([d1, d2, d3].map((d) => matchesFor({ any: [emea, de] }, d)), [true, true, true]);
  assert.deepEqual([d1, d2, d3].map((d) => matchesFor({ any: [emea, de], not: true }, d)), [false, false, false]);
  assert.deepEqual([d1, d2, facts("x.com")].map((d) => matchesFor({ any: [emea, de], not: true }, d)), [false, false, true]);
});

test("nested groups: has tag emea AND (domain ends .de OR policy is not reject)", () => {
  const expr = { all: [{ field: "tag", op: "has", value: "emea" }, { any: [{ field: "domain", op: "ends", value: ".de" }, { field: "policy", op: "is_not", value: "reject" }] }] };
  assert.equal(matchesFor(expr, facts("a.de", ["emea"], "reject")), true);
  assert.equal(matchesFor(expr, facts("a.fr", ["emea"], "none")), true);
  assert.equal(matchesFor(expr, facts("a.fr", ["emea"], "reject")), false);
  assert.equal(matchesFor(expr, facts("a.de", [], "none")), false);
  assert.equal(describe(must(expr)), "has tag emea and (domain ends with .de or policy is not reject)");
});

test("every tag operator", () => {
  const t = facts("a.example", ["emea", "prod"]);
  const none = facts("b.example", []);
  const c = (op: string, value?: unknown) => matchesFor({ field: "tag", op, value }, t);
  assert.deepEqual([c("has", "prod"), c("has", "apac"), c("not_has", "apac"), c("not_has", "prod")], [true, false, true, false]);
  assert.deepEqual([c("has_any", ["apac", "prod"]), c("has_any", ["apac"]), c("has_all", ["emea", "prod"]), c("has_all", ["emea", "apac"])], [true, false, true, false]);
  assert.deepEqual([c("has_none", ["apac"]), c("has_none", ["emea", "x"]), c("any_tag"), c("no_tags")], [true, false, true, false]);
  assert.equal(matchesFor({ field: "tag", op: "no_tags" }, none), true);
  assert.equal(matchesFor({ field: "tag", op: "any_tag" }, none), false);
});

test("every domain operator, case-insensitively", () => {
  const d = facts("Shop.Example.DE");
  const c = (op: string, value: unknown) => matchesFor({ field: "domain", op, value }, d);
  assert.deepEqual([c("eq", "shop.example.de"), c("neq", "shop.example.de"), c("contains", "EXAMPLE"), c("not_contains", "example"), c("starts", "shop."), c("ends", ".DE")], [true, false, true, false, true, true]);
  assert.deepEqual([c("in", ["a.com", "shop.example.de"]), c("in", ["a.com"]), c("not_in", ["a.com"]), c("not_in", ["shop.example.de"])], [true, false, true, false]);
});

test("policy operators, with 'unknown' for a domain nobody has reported on", () => {
  const c = (op: string, value: unknown, policy: string | null) => matchesFor({ field: "policy", op, value }, facts("a.example", [], policy));
  assert.deepEqual([c("is", "reject", "reject"), c("is", "reject", "none"), c("is_not", "reject", "none"), c("is", "unknown", null), c("is_not", "unknown", null)], [true, false, true, true, false]);
  assert.deepEqual([c("in", ["none", "quarantine"], "none"), c("in", ["none"], "reject"), c("not_in", ["reject"], "none"), c("in", ["unknown"], null)], [true, false, true, true]);
});

test("values are normalised: tags lowercased, lists split and de-duplicated, empty groups dropped", () => {
  assert.deepEqual(must({ field: "tag", op: "has_any", value: "EMEA, prod ,emea,," }).items, [{ field: "tag", op: "has_any", value: ["emea", "prod"] }]);
  assert.equal(parseExpr({ all: [] }).ok && (parseExpr({ all: [] }) as { expr: unknown }).expr, null, "an empty filter means no filter");
  assert.deepEqual(must({ all: [{ any: [] }, { field: "tag", op: "has", value: "x" }] }).items.length, 1);
  assert.equal(normalizeTag(" Team Payments "), "team-payments");
  assert.equal(normalizeTag("a".repeat(33)), null);
  assert.equal(normalizeTag("-bad"), null);
  assert.equal(normalizeTag("has space!"), null);
  assert.equal(normalizeDomain(" Example.COM. "), "example.com");
  assert.equal(normalizeDomain("bad domain"), null);
  assert.equal(normalizeDomain(""), null);
});

test("bad input is refused with a reason, never thrown", () => {
  assert.match(err({ field: "colour", op: "is", value: "red" }), /Unknown field/);
  assert.match(err({ field: "tag", op: "ends", value: "x" }), /can't be used with tag/);
  assert.match(err({ field: "tag", op: "has", value: "Bad Tag!" }), /Tags use/);
  assert.match(err({ field: "tag", op: "has" }), /Tags use/);
  assert.match(err({ field: "tag", op: "has_any", value: [] }), /at least one/);
  assert.match(err({ field: "policy", op: "is", value: "strict" }), /Policy must be/);
  assert.match(err({ field: "domain", op: "eq", value: "" }), /Enter a value/);
  assert.match(err({ all: "nope" }), /list of items/);
  assert.match(err([1, 2]), /condition or a group/);
  assert.match(err("text"), /condition or a group/);
  assert.match(err({ field: "tag", op: "has_any", value: Array.from({ length: 101 }, (_, i) => `t${i}`) }), /at most 100/);
});

test("size limits keep a filter cheap to evaluate", () => {
  const many = { all: Array.from({ length: MAX_NODES + 1 }, () => ({ field: "tag", op: "any_tag" })) };
  assert.match(err(many), new RegExp(`at most ${MAX_NODES}`));
  let deep: unknown = { field: "tag", op: "any_tag" };
  for (let i = 0; i <= MAX_DEPTH; i++) deep = { all: [deep] };
  assert.match(err(deep), /nested at most/);
  let ok: unknown = { field: "tag", op: "any_tag" };
  for (let i = 0; i < MAX_DEPTH; i++) ok = { any: [ok] };
  assert.ok(parseExpr(ok).ok);
});

test("unknown properties cannot smuggle anything through", () => {
  const e = must({ field: "tag", op: "has", value: "x", extra: "<script>", __proto__: { evil: true } });
  assert.deepEqual(e.items[0], { field: "tag", op: "has", value: "x" });
  assert.ok(!JSON.stringify(e).includes("script"));
});

test("it round-trips through the URL form, and junk in the URL means no filter", () => {
  const e = must({ all: [{ field: "tag", op: "has_any", value: ["emea", "prod"] }, { any: [{ field: "domain", op: "ends", value: ".de" }], not: true }] });
  assert.deepEqual(decodeExpr(encodeExpr(e)), e);
  for (const junk of [null, undefined, "", "not json", "{", "[]", '{"field":"x"}', "x".repeat(2001)]) assert.equal(decodeExpr(junk as string), null, String(junk).slice(0, 20));
  assert.equal(encodeExpr(null), "");
  assert.deepEqual(decodeExpr(encodeExpr(tagFilter("emea"))), tagFilter("emea"));
});

test("which fields a filter uses (so the policy is only looked up when needed)", () => {
  assert.deepEqual([...fieldsUsed(must({ field: "tag", op: "has", value: "x" }))], ["tag"]);
  assert.deepEqual([...fieldsUsed(must({ any: [{ field: "policy", op: "is", value: "none" }, { all: [{ field: "domain", op: "eq", value: "a.com" }] }] }))].sort(), ["domain", "policy"]);
});
