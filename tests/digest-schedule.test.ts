import test from "node:test";
import assert from "node:assert/strict";
import { digestDue, latestSlot, nextSlot, zonedToEpoch, zonedParts, type DigestSchedule } from "../src/digest-schedule.ts";

const iso = (s: number) => new Date(s * 1000).toISOString();
const at = (s: string) => Math.floor(Date.parse(s) / 1000);

const base: DigestSchedule = { mode: "daily", everyDays: 3, weekday: 1, dayOfMonth: 1, hour: 9, timezone: "America/New_York" };

test("zonedToEpoch converts a New York wall clock to UTC (EDT and EST)", () => {
  assert.equal(iso(zonedToEpoch(2026, 7, 1, 9, "America/New_York")), "2026-07-01T13:00:00.000Z");
  assert.equal(iso(zonedToEpoch(2026, 1, 15, 9, "America/New_York")), "2026-01-15T14:00:00.000Z");
});

test("zonedParts round-trips and reports the weekday in the zone", () => {
  const p = zonedParts(at("2026-10-22T03:00:00Z"), "America/New_York"); // still Oct 21 evening locally
  assert.deepEqual([p.y, p.m, p.d, p.h], [2026, 10, 21, 23]);
  assert.equal(p.weekday, 3); // Wednesday
});

test("daily: the latest slot is today's if the hour has passed, else yesterday's", () => {
  assert.equal(iso(latestSlot(at("2026-07-01T15:00:00Z"), base)!), "2026-07-01T13:00:00.000Z");
  assert.equal(iso(latestSlot(at("2026-07-01T12:00:00Z"), base)!), "2026-06-30T13:00:00.000Z");
});

test("daily: due once per slot, not again until the next day", () => {
  const enabledAt = at("2026-06-01T00:00:00Z");
  const now = at("2026-07-01T13:30:00Z");
  const first = digestDue(base, null, enabledAt, now);
  assert.equal(first.due, true);
  const again = digestDue(base, first.slot, enabledAt, now + 900);
  assert.equal(again.due, false);
  assert.equal(iso(again.slot!), "2026-07-02T13:00:00.000Z");
});

test("a newly enabled schedule does not fire for a slot that was already in the past", () => {
  const enabledAt = at("2026-07-01T20:00:00Z"); // after today's 09:00 local slot
  const { due, slot } = digestDue(base, null, enabledAt, at("2026-07-01T20:05:00Z"));
  assert.equal(due, false);
  assert.equal(iso(slot!), "2026-07-02T13:00:00.000Z");
});

test("missed cron runs catch up once, not repeatedly", () => {
  const enabledAt = at("2026-06-01T00:00:00Z");
  const lastSlot = at("2026-07-01T13:00:00Z");
  const now = at("2026-07-03T22:00:00Z"); // two days later; cron was down
  const d = digestDue(base, lastSlot, enabledAt, now);
  assert.equal(d.due, true);
  assert.equal(iso(d.slot!), "2026-07-03T13:00:00.000Z");
  assert.equal(digestDue(base, d.slot, enabledAt, now + 60).due, false);
});

test("weekly: fires on the chosen weekday in the zone", () => {
  const weekly: DigestSchedule = { ...base, mode: "weekly", weekday: 1 }; // Monday 09:00 New York
  assert.equal(iso(latestSlot(at("2026-07-08T00:00:00Z"), weekly)!), "2026-07-06T13:00:00.000Z"); // Wed -> previous Mon
  assert.equal(iso(latestSlot(at("2026-07-06T13:00:00Z"), weekly)!), "2026-07-06T13:00:00.000Z"); // exactly on the slot
  assert.equal(iso(latestSlot(at("2026-07-06T12:59:00Z"), weekly)!), "2026-06-29T13:00:00.000Z"); // a minute early
});

test("monthly: uses the day of month, across a year boundary", () => {
  const monthly: DigestSchedule = { ...base, mode: "monthly", dayOfMonth: 15 };
  assert.equal(iso(latestSlot(at("2027-01-10T00:00:00Z"), monthly)!), "2026-12-15T14:00:00.000Z"); // EST in December
  assert.equal(iso(latestSlot(at("2027-01-20T00:00:00Z"), monthly)!), "2027-01-15T14:00:00.000Z");
});

test("every N days: first slot after enabling, then N calendar days apart", () => {
  const s: DigestSchedule = { ...base, mode: "days", everyDays: 3 };
  const enabledAt = at("2026-07-01T20:00:00Z");
  const first = nextSlot(s, null, enabledAt, enabledAt)!;
  assert.equal(iso(first), "2026-07-02T13:00:00.000Z");
  assert.equal(iso(nextSlot(s, first, enabledAt, first + 10)!), "2026-07-05T13:00:00.000Z");
});

test("DST: the local hour stays at 09:00 across the spring-forward change", () => {
  const s: DigestSchedule = { ...base, mode: "days", everyDays: 1 };
  const before = at("2026-03-07T14:00:00Z"); // Mar 7 09:00 EST
  const next = nextSlot(s, before, 0, before)!;
  assert.equal(iso(next), "2026-03-08T13:00:00.000Z"); // Mar 8 09:00 EDT (clocks moved at 02:00)
});

test("off never fires", () => {
  const off: DigestSchedule = { ...base, mode: "off" };
  assert.equal(digestDue(off, null, 0, at("2026-07-01T20:00:00Z")).due, false);
  assert.equal(nextSlot(off, null, 0, 0), null);
});

test("UTC and a far-east zone", () => {
  const utc: DigestSchedule = { ...base, timezone: "UTC", hour: 13 };
  assert.equal(iso(latestSlot(at("2026-07-01T13:00:00Z"), utc)!), "2026-07-01T13:00:00.000Z");
  const tokyo: DigestSchedule = { ...base, timezone: "Asia/Tokyo", hour: 9 };
  assert.equal(iso(latestSlot(at("2026-07-01T00:30:00Z"), tokyo)!), "2026-07-01T00:00:00.000Z");
});
