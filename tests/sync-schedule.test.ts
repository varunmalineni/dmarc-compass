import test from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeInterval, syncDue, nextSyncAt, containerIntervalSeconds, staleAfterSeconds, intervalLabel, scheduleTooSlow, observeTick, typicalGap,
  TICK_SECONDS, PRESETS, DEFAULT_INTERVAL,
} from "../src/sync-schedule.ts";

const T = 1_800_000_000;

test("interval is clamped to 5 minutes..24 hours; junk becomes the default", () => {
  assert.equal(sanitizeInterval(15), 15);
  assert.equal(sanitizeInterval("30"), 30);
  assert.equal(sanitizeInterval(1), 5);
  assert.equal(sanitizeInterval(0), 5);
  assert.equal(sanitizeInterval(-9), 5);
  assert.equal(sanitizeInterval(99999), 1440);
  assert.equal(sanitizeInterval(7.6), 8);
  for (const bad of [undefined, null, "", "abc", NaN, {}, []]) assert.equal(sanitizeInterval(bad), DEFAULT_INTERVAL);
  assert.ok(PRESETS.every((p) => sanitizeInterval(p) === p));
});

test("the first run is always due", () => {
  assert.equal(syncDue(null, 15, T), true);
});

test("a 15 minute interval fires on every third 5-minute tick, even with ticks a little early", () => {
  const last = T;
  assert.equal(syncDue(last, 15, last + 300), false);
  assert.equal(syncDue(last, 15, last + 600), false);
  assert.equal(syncDue(last, 15, last + 900), true);
  assert.equal(syncDue(last, 15, last + 900 - 120), true); // cron fired 2 minutes early: still counts
  assert.equal(syncDue(last, 15, last + 900 - 200), false);
});

test("no drift: stepping through ticks syncs exactly every third tick for an hour", () => {
  let last: number | null = null;
  const ran: number[] = [];
  for (let i = 0; i < 13; i++) {
    const now = T + i * TICK_SECONDS + (i % 2 ? 7 : -5); // jitter either side
    if (syncDue(last, 15, now)) { ran.push(i); last = now; }
  }
  assert.deepEqual(ran, [0, 3, 6, 9, 12]);
});

test("long intervals: 6 hours is due only after about 6 hours", () => {
  assert.equal(syncDue(T, 360, T + 5 * 3600), false);
  assert.equal(syncDue(T, 360, T + 6 * 3600), true);
  assert.equal(syncDue(T, 1440, T + 23 * 3600), false);
  assert.equal(syncDue(T, 1440, T + 24 * 3600), true);
});

test("the minimum interval syncs on every tick", () => {
  assert.equal(syncDue(T, 5, T + 300), true);
  assert.equal(syncDue(T, 5, T + 60), false);
});

test("next sync time is a tick boundary in the future, or null when due", () => {
  assert.equal(nextSyncAt(null, 15, T), null);
  assert.equal(nextSyncAt(T, 15, T + 900), null);
  const n = nextSyncAt(T, 60, T + 100)!;
  assert.ok(n > T + 100);
  assert.equal(n % TICK_SECONDS, 0);
  assert.ok(n - T >= 3600 - TICK_SECONDS && n - T <= 3600 + TICK_SECONDS);
});

test("the container re-reads between every 5 and 15 minutes", () => {
  assert.equal(containerIntervalSeconds(5), 300);
  assert.equal(containerIntervalSeconds(10), 600);
  assert.equal(containerIntervalSeconds(15), 900);
  assert.equal(containerIntervalSeconds(360), 900);
  assert.equal(containerIntervalSeconds(1440), 900);
});

test("the sync-problem alert never fires between two healthy syncs", () => {
  assert.equal(staleAfterSeconds(90, 15), 90 * 60); // default behaviour is unchanged
  assert.equal(staleAfterSeconds(90, 60), 180 * 60);
  assert.equal(staleAfterSeconds(90, 360), 18 * 3600);
  assert.ok(staleAfterSeconds(30, 1440) >= 3 * 1440 * 60);
});

test("labels", () => {
  assert.deepEqual(PRESETS.map(intervalLabel), ["5 minutes", "10 minutes", "15 minutes", "30 minutes", "1 hour", "2 hours", "4 hours", "6 hours", "12 hours", "24 hours"]);
  assert.equal(intervalLabel(90), "90 minutes");
});

test("a cron slower than the chosen interval is detected", () => {
  assert.equal(scheduleTooSlow(null, 5), false); // unknown: say nothing
  assert.equal(scheduleTooSlow(900, 5), true); // deployed every 15, wants 5
  assert.equal(scheduleTooSlow(900, 10), true);
  assert.equal(scheduleTooSlow(900, 15), false);
  assert.equal(scheduleTooSlow(300, 5), false);
  assert.equal(scheduleTooSlow(300, 360), false);
});

test("observed tick gaps ignore pauses and the first tick, and keep the latest five", () => {
  assert.deepEqual(observeTick(null, T, []), []);
  assert.deepEqual(observeTick(T, T + 300, []), [300]);
  assert.deepEqual(observeTick(T, T + 20000, [300]), [300]); // a long outage is not the schedule
  assert.deepEqual(observeTick(T, T, [300]), [300]);
  assert.deepEqual([1, 2, 3, 4, 5, 6].reduce<number[]>((g, i) => observeTick(T, T + i, g), []), [2, 3, 4, 5, 6]);
});

test("the typical gap is the median, so one missed run does not trigger the warning", () => {
  assert.equal(typicalGap([]), null);
  assert.equal(typicalGap([300]), 300);
  assert.equal(typicalGap([300, 300, 600, 300, 300]), 300); // one tick missed
  assert.equal(scheduleTooSlow(typicalGap([300, 300, 600, 300, 300]), 5), false);
  assert.equal(typicalGap([900, 900, 900]), 900); // deployed every 15
  assert.equal(scheduleTooSlow(typicalGap([300, 900, 900, 900, 900]), 5), true); // schedule was changed to slower
});
