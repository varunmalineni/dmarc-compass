import test from "node:test";
import assert from "node:assert/strict";
import { filterKey, groupByFilter, inScope, planAlerts, settle, scopeLine } from "../src/routing.ts";
import { tagFilter, parseExpr, type Group } from "../src/domain-filter.ts";

const f = (x: unknown): Group => {
  const p = parseExpr(x);
  assert.ok(p.ok && p.expr);
  return p.expr;
};
const alert = (key: string, domain?: string) => ({ key, data: domain === undefined ? { problem: "sync_failed" } : { domain } });

test("hooks with the same filter are one group; no filter is its own group; order is kept", () => {
  const emea = tagFilter("emea");
  const groups = groupByFilter([
    { id: "a", filter: emea },
    { id: "b", filter: null },
    { id: "c", filter: tagFilter("emea") },
    { id: "d", filter: null },
    { id: "e", filter: tagFilter("bx") },
  ]);
  assert.deepEqual(groups.map((g) => g.hooks.map((h) => h.id)), [["a", "c"], ["b", "d"], ["e"]]);
  assert.equal(filterKey(null), "");
  assert.notEqual(filterKey(tagFilter("emea")), filterKey(tagFilter("bx")));
});

test("an alert reaches a scope that holds its domain; alerts with no domain reach every scope; null scope takes all", () => {
  const scope = new Set(["shop.de"]);
  assert.equal(inScope(alert("1", "shop.de"), scope), true);
  assert.equal(inScope(alert("2", "other.com"), scope), false);
  assert.equal(inScope(alert("3"), scope), true);
  assert.equal(inScope(alert("3"), new Set()), true, "even an empty scope hears about sync problems");
  assert.equal(inScope(alert("4", "other.com"), null), true);
  assert.equal(inScope(alert("4", "other.com"), new Set()), false);
});

test("planAlerts: each group gets its own alerts, and a group with none is left out", () => {
  const alerts = [alert("1", "shop.de"), alert("2", "blog.com"), alert("3", "shop.fr"), alert("sync")];
  const plan = planAlerts(alerts, [
    { group: "all", scope: null },
    { group: "emea", scope: new Set(["shop.de", "shop.fr"]) },
    { group: "none", scope: new Set(["nothing.example"]) },
    { group: "empty", scope: new Set<string>() },
  ]);
  const by = Object.fromEntries(plan.sends.map((s) => [s.group, s.alerts.map((a) => a.key)]));
  assert.deepEqual(by.all, ["1", "2", "3", "sync"]);
  assert.deepEqual(by.emea, ["1", "3", "sync"]);
  assert.deepEqual(by.none, ["sync"]);
  assert.deepEqual(by.empty, ["sync"]);
});

test("settle: delivered or unwanted alerts are done; wanted but undelivered ones are tried again", () => {
  const alerts = [alert("a", "shop.de"), alert("b", "blog.com"), alert("c", "lost.example")];
  const plan = planAlerts(alerts, [{ group: "g", scope: new Set(["shop.de", "blog.com"]) }]);
  const r = settle(alerts, plan, new Set(["a"]));
  assert.deepEqual(r.done.map((a) => a.key), ["a", "c"], "c is wanted by nobody");
  assert.deepEqual(r.retry.map((a) => a.key), ["b"]);
  assert.deepEqual(settle(alerts, plan, new Set(["a", "b"])).retry, []);
});

test("scopeLine says whose data a message holds", () => {
  assert.equal(scopeLine(null), null);
  assert.equal(scopeLine("has tag emea"), "Only domains where has tag emea");
  assert.equal(scopeLine("has tag emea", 1), "Only domains where has tag emea (1 domain now)");
  assert.equal(scopeLine("has tag emea", 12), "Only domains where has tag emea (12 domains now)");
});
