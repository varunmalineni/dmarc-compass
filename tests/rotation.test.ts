import test from "node:test";
import assert from "node:assert/strict";
import { runRotation, turnOrder, summarize, type RotationDeps } from "../src/rotation.ts";

interface M { id: string; name: string }
const boxes: M[] = ["a", "b", "c", "d"].map((id) => ({ id, name: id.toUpperCase() }));

function fake(overrides: Partial<{ failLoad: string[]; throwSync: string[]; cost: number }> = {}) {
  let t = 0;
  const calls: string[] = [];
  const records: Array<[string, boolean, string]> = [];
  const deps: RotationDeps<M> = {
    now: () => t,
    async load(m) {
      calls.push("load:" + m.id);
      t += overrides.cost ?? 1000;
      return overrides.failLoad?.includes(m.id) ? { ok: false, error: "login failed" } : { ok: true };
    },
    async sync(m) {
      calls.push("sync:" + m.id);
      if (overrides.throwSync?.includes(m.id)) throw new Error("boom " + m.id);
      return { newReports: 2, newTlsReports: 1 };
    },
    async record(m, o) { records.push([m.id, o.ok, o.detail]); },
  };
  return { deps, calls, records };
}
const opts = { budgetMs: 10_000, minPerMailboxMs: 2000 };

test("turn order starts at the cursor and wraps", () => {
  assert.deepEqual(turnOrder([1, 2, 3, 4], 0), [1, 2, 3, 4]);
  assert.deepEqual(turnOrder([1, 2, 3, 4], 2), [3, 4, 1, 2]);
  assert.deepEqual(turnOrder([1, 2, 3, 4], 6), [3, 4, 1, 2]);
  assert.deepEqual(turnOrder([1, 2, 3, 4], -1), [4, 1, 2, 3]);
  assert.deepEqual(turnOrder([], 3), []);
});

test("every mailbox gets a turn, in order, and the cursor wraps to the start", async () => {
  const { deps, calls } = fake();
  const r = await runRotation(boxes, 0, deps, opts);
  assert.deepEqual(calls, ["load:a", "sync:a", "load:b", "sync:b", "load:c", "sync:c", "load:d", "sync:d"]);
  assert.equal(r.partial, false);
  assert.equal(r.nextCursor, 0);
  assert.deepEqual(r.outcomes.map((o) => o.ok), [true, true, true, true]);
});

test("a failing mailbox is recorded and does not stop the others", async () => {
  const { deps, records } = fake({ failLoad: ["b"], throwSync: ["c"] });
  const r = await runRotation(boxes, 0, deps, opts);
  assert.deepEqual(r.outcomes.map((o) => [o.id, o.ok]), [["a", true], ["b", false], ["c", false], ["d", true]]);
  assert.equal(r.outcomes[1].error, "login failed");
  assert.equal(r.outcomes[2].error, "boom c");
  assert.deepEqual(records.map((x) => [x[0], x[1]]), [["a", true], ["b", false], ["c", false], ["d", true]]);
  assert.match(records[0][2], /2 new DMARC reports, 1 new TLS reports/);
});

test("when the time budget runs out the run stops, and the next run continues where it left off", async () => {
  const { deps: d1 } = fake({ cost: 5000 });
  const first = await runRotation(boxes, 0, d1, opts); // 5s each, 10s budget, 2s minimum: after b only 0s is left, so stop
  assert.deepEqual(first.outcomes.map((o) => o.id), ["a", "b"]);
  assert.equal(first.partial, true);
  assert.equal(first.nextCursor, 2);
  const { deps: d2 } = fake({ cost: 5000 });
  const second = await runRotation(boxes, first.nextCursor, d2, opts);
  assert.deepEqual(second.outcomes.map((o) => o.id), ["c", "d"]);
  assert.equal(second.nextCursor, 0);
});

test("the first mailbox always gets a turn, even if it alone exceeds the budget", async () => {
  const { deps } = fake({ cost: 60_000 });
  const r = await runRotation(boxes, 0, deps, opts);
  assert.deepEqual(r.outcomes.map((o) => o.id), ["a"]);
  assert.equal(r.nextCursor, 1);
});

test("a slow mailbox cannot starve the others across runs", async () => {
  let cursor = 0;
  const seen = new Set<string>();
  for (let run = 0; run < 6; run++) {
    const { deps } = fake({ cost: 60_000 });
    const r = await runRotation(boxes, cursor, deps, opts);
    r.outcomes.forEach((o) => seen.add(o.id));
    cursor = r.nextCursor;
  }
  assert.equal(seen.size, 4);
});

test("a single mailbox runs every time and the cursor stays at zero", async () => {
  const one = [boxes[0]];
  const { deps } = fake();
  const r = await runRotation(one, 0, deps, opts);
  assert.equal(r.outcomes.length, 1);
  assert.equal(r.nextCursor, 0);
  assert.equal(r.partial, false);
});

test("no mailboxes: nothing happens", async () => {
  const { deps, calls } = fake();
  const r = await runRotation([], 5, deps, opts);
  assert.deepEqual(calls, []);
  assert.equal(r.nextCursor, 0);
});

test("a failure while recording a result does not abort the run", async () => {
  const { deps } = fake();
  deps.record = async () => { throw new Error("db down"); };
  const r = await runRotation(boxes, 0, deps, opts);
  assert.equal(r.outcomes.length, 4);
});

test("summary wording", () => {
  const ok = (id: string) => ({ id, name: id, ok: true, newReports: 2, newTlsReports: 1 });
  assert.deepEqual(summarize([ok("a")], false), { ok: true, text: "2 new DMARC reports, 1 new TLS reports" });
  assert.equal(summarize([ok("a"), ok("b")], false).text, "4 new DMARC reports, 2 new TLS reports across 2 of 2 mailboxes");
  const bad = { id: "b", name: "Ops", ok: false, newReports: 0, newTlsReports: 0, error: "login failed" };
  const s = summarize([ok("a"), bad], true);
  assert.equal(s.ok, false);
  assert.match(s.text, /across 1 of 2 mailboxes; failed: Ops \(login failed\); the rest continue on the next run/);
  assert.equal(summarize([], false).text, "no enabled mailboxes");
  assert.ok(summarize(Array.from({ length: 10 }, (_, i) => ({ ...bad, id: String(i), error: "x".repeat(50) })), false).text.length <= 200);
});
