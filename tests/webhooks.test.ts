import test from "node:test";
import assert from "node:assert/strict";
import { addHook, updateHook, removeHook, parseHooks, serializeHooks, receiving, toView, MAX_HOOKS, type Hook } from "../src/webhooks.ts";
import { evaluate } from "../src/domain-filter.ts";
const NO_TAGS: ReadonlySet<string> = new Set();

const URL1 = "https://hooks.slack.com/services/T1/B1/aaaa1111";
const URL2 = "https://hooks.slack.com/services/T2/B2/bbbb2222";

function must<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  assert.equal(r.ok, true, JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
}

test("add: validates, defaults to receiving everything, and sanitises the nickname", () => {
  const r = must(addHook([], { url: URL1, name: "  #alerts \n" }, "a1"));
  assert.deepEqual(r.hook, { id: "a1", type: "slack", name: "#alerts", url: URL1, secret: "", alerts: true, digest: true, filter: null });
  assert.equal(r.list.length, 1);
});

test("add: rejects bad URLs, empty input and duplicates", () => {
  assert.equal(addHook([], { url: "http://insecure.example/x" }, "a").ok, false);
  assert.equal(addHook([], { url: "" }, "a").ok, false);
  assert.equal(addHook([], { url: 42 }, "a").ok, false);
  const one = must(addHook([], { url: URL1 }, "a1")).list;
  const dup = addHook(one, { url: URL1 + "  " }, "a2");
  assert.equal(dup.ok, false);
  assert.match((dup as { error: string }).error, /already/);
});

test("add: enforces the maximum", () => {
  let list: Hook[] = [];
  for (let i = 0; i < MAX_HOOKS; i++) list = must(addHook(list, { url: `https://hooks.example.com/${i}` }, `h${i}`)).list;
  const over = addHook(list, { url: "https://hooks.example.com/extra" }, "x");
  assert.equal(over.ok, false);
});

test("add: honours explicit routing flags", () => {
  const r = must(addHook([], { url: URL1, alerts: true, digest: false }, "a"));
  assert.equal(r.hook.digest, false);
});

test("update: renames and re-routes one hook without touching the others", () => {
  let list = must(addHook([], { url: URL1, name: "one" }, "a")).list;
  list = must(addHook(list, { url: URL2, name: "two" }, "b")).list;
  const next = must(updateHook(list, "b", { name: "  renamed ", digest: false })).list;
  assert.deepEqual(next[0], list[0]);
  assert.equal(next[1].name, "renamed");
  assert.equal(next[1].digest, false);
  assert.equal(next[1].alerts, true);
  assert.equal(next[1].url, URL2);
});

test("update: a missing patch field keeps the current value; an unknown id fails", () => {
  const list = must(addHook([], { url: URL1, name: "keep" }, "a")).list;
  assert.equal(must(updateHook(list, "a", {})).list[0].name, "keep");
  assert.equal(must(updateHook(list, "a", { name: "" })).list[0].name, ""); // empty clears it
  assert.equal(updateHook(list, "nope", { name: "x" }).ok, false);
});

test("remove: drops only the chosen hook", () => {
  let list = must(addHook([], { url: URL1 }, "a")).list;
  list = must(addHook(list, { url: URL2 }, "b")).list;
  assert.deepEqual(removeHook(list, "a").map((h) => h.id), ["b"]);
  assert.equal(removeHook(list, "zzz").length, 2);
});

test("receiving: alerts and digest are routed independently", () => {
  let list = must(addHook([], { url: URL1, alerts: true, digest: false }, "a")).list;
  list = must(addHook(list, { url: URL2, alerts: false, digest: true }, "b")).list;
  assert.deepEqual(receiving("alerts", list).map((h) => h.id), ["a"]);
  assert.deepEqual(receiving("digest", list).map((h) => h.id), ["b"]);
});

test("parse: tolerates garbage, skips bad entries, de-duplicates ids", () => {
  assert.deepEqual(parseHooks("not json"), []);
  assert.deepEqual(parseHooks('{"a":1}'), []);
  const good = { id: "a", type: "slack", name: "ok", url: URL1, secret: "", alerts: true, digest: false };
  const parsed = parseHooks(JSON.stringify([good, null, 5, { id: "b", url: "http://insecure" }, { url: URL2 }, good, { id: "c", url: URL2, name: 7 }]));
  assert.deepEqual(parsed.map((h) => h.id), ["a", "c"]);
  assert.equal(parsed[0].digest, false);
  assert.equal(parsed[1].name, "");
});

test("view never exposes the URL, only a masked form", () => {
  const v = toView({ id: "a", type: "slack", name: "n", url: URL1, secret: "", alerts: true, digest: true }, "saved");
  assert.equal(v.masked, "https://hooks.slack.com/••••1111");
  assert.ok(!JSON.stringify(v).includes("T1/B1"));
});

test("json webhooks: type is kept, the secret is trimmed, and slack hooks never carry one", () => {
  const j = must(addHook([], { url: URL1, type: "json", secret: "  s3cret  " }, "j"));
  assert.equal(j.hook.type, "json");
  assert.equal(j.hook.secret, "s3cret");
  const s = must(addHook([], { url: URL2, type: "slack", secret: "ignored" }, "s"));
  assert.equal(s.hook.secret, "");
  assert.equal(must(addHook([], { url: URL1, type: "bogus" }, "x")).hook.type, "slack");
});

test("json webhooks: updating the secret keeps, replaces or removes it", () => {
  const list = must(addHook([], { url: URL1, type: "json", secret: "one" }, "j")).list;
  assert.equal(must(updateHook(list, "j", { name: "n" })).list[0].secret, "one"); // untouched
  assert.equal(must(updateHook(list, "j", { secret: "two" })).list[0].secret, "two");
  assert.equal(must(updateHook(list, "j", { secret: "" })).list[0].secret, ""); // removed
  const slack = must(addHook([], { url: URL2 }, "s")).list;
  assert.equal(must(updateHook(slack, "s", { secret: "nope" })).list[0].secret, ""); // slack hooks ignore it
});

test("json webhooks: the view says whether it is signed, without exposing the secret", () => {
  const h = must(addHook([], { url: URL1, type: "json", secret: "topsecret" }, "j")).hook;
  const v = toView(h, "saved");
  assert.equal(v.signed, true);
  assert.equal(v.type, "json");
  assert.ok(!JSON.stringify(v).includes("topsecret"));
});

test("parse: lists saved before types existed load as slack webhooks", () => {
  const old = JSON.stringify([{ id: "h1", name: "Old", url: URL1, alerts: true, digest: true }]);
  const [h] = parseHooks(old);
  assert.equal(h.type, "slack");
  assert.equal(h.secret, "");
});

test("parse: a stored json hook keeps its secret", () => {
  const [h] = parseHooks(JSON.stringify([{ id: "j", type: "json", url: URL1, secret: "abc" }]));
  assert.equal(h.secret, "abc");
});

// ----------------------------------------------------------------- filters

const EMEA = { field: "tag", op: "has", value: "emea" };

test("a filter is optional, and is checked when given", () => {
  assert.equal(must(addHook([], { url: URL1, filter: null }, "a")).hook.filter, null);
  assert.equal(must(addHook([], { url: URL1, filter: "" }, "a")).hook.filter, null);
  const h = must(addHook([], { url: URL1, filter: { all: [EMEA] } }, "a")).hook;
  assert.equal(h.filter?.items.length, 1);
  const bad = addHook([], { url: URL1, filter: { all: [{ field: "tag", op: "nope", value: "x" }] } }, "a");
  assert.equal(bad.ok, false);
  assert.equal(addHook([], { url: URL1, filter: "emea" }, "a").ok, false);
});

test("update: no filter in the patch keeps it, null removes it, a new one replaces it, a bad one is refused", () => {
  const list = must(addHook([], { url: URL1, filter: { all: [EMEA] } }, "a")).list;
  assert.ok(must(updateHook(list, "a", { name: "x" })).list[0].filter);
  assert.equal(must(updateHook(list, "a", { filter: null })).list[0].filter, null);
  const next = must(updateHook(list, "a", { filter: { any: [{ field: "domain", op: "ends", value: ".de" }] } })).list[0].filter;
  assert.equal(next?.mode, "any");
  const bad = updateHook(list, "a", { filter: { all: [{ field: "x" }] } });
  assert.equal(bad.ok, false);
});

test("a stored filter survives save and load", () => {
  const list = must(addHook([], { url: URL1, filter: { all: [EMEA, { not: true, any: [{ field: "policy", op: "is", value: "reject" }] }] } }, "a")).list;
  const back = parseHooks(serializeHooks(list));
  assert.deepEqual(back, list);
  assert.equal(toView(back[0], "saved").filterText, "has tag emea and not (policy is reject)");
  assert.deepEqual(toView(back[0], "saved").filter, { all: [EMEA, { any: [{ field: "policy", op: "is", value: "reject" }], not: true }] });
  assert.equal(toView({ ...back[0], filter: null }, "saved").filterText, null);
});

test("hooks saved before filters existed load as 'every domain'", () => {
  assert.equal(parseHooks(JSON.stringify([{ id: "h", url: URL1 }]))[0].filter, null);
});

test("a stored filter that cannot be read matches nothing, instead of widening to every domain", () => {
  const [h] = parseHooks(JSON.stringify([{ id: "h", url: URL1, filter: { all: [{ field: "tag", op: "gone" }] } }]));
  assert.ok(h.filter);
  assert.equal(evaluate(h.filter, { domain: "shop.de", tags: NO_TAGS, policy: null }), false);
  assert.equal(evaluate(h.filter, { domain: "-", tags: NO_TAGS, policy: null }), true, "only a domain named '-' could match");
});
