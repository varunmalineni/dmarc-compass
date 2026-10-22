import test from "node:test";
import assert from "node:assert/strict";
import { addHook, updateHook, removeHook, parseHooks, receiving, toView, MAX_HOOKS, type Hook } from "../src/webhooks.ts";

const URL1 = "https://hooks.slack.com/services/T1/B1/aaaa1111";
const URL2 = "https://hooks.slack.com/services/T2/B2/bbbb2222";

function must<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  assert.equal(r.ok, true, JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
}

test("add: validates, defaults to receiving everything, and sanitises the nickname", () => {
  const r = must(addHook([], { url: URL1, name: "  #alerts \n" }, "a1"));
  assert.deepEqual(r.hook, { id: "a1", name: "#alerts", url: URL1, alerts: true, digest: true });
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
  const good = { id: "a", name: "ok", url: URL1, alerts: true, digest: false };
  const parsed = parseHooks(JSON.stringify([good, null, 5, { id: "b", url: "http://insecure" }, { url: URL2 }, good, { id: "c", url: URL2, name: 7 }]));
  assert.deepEqual(parsed.map((h) => h.id), ["a", "c"]);
  assert.equal(parsed[0].digest, false);
  assert.equal(parsed[1].name, "");
});

test("view never exposes the URL, only a masked form", () => {
  const v = toView({ id: "a", name: "n", url: URL1, alerts: true, digest: true }, "saved");
  assert.equal(v.masked, "https://hooks.slack.com/••••1111");
  assert.ok(!JSON.stringify(v).includes("T1/B1"));
});
