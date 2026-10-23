import test from "node:test";
import assert from "node:assert/strict";
import { recordFailure, isLocked, retryAfter, MAX_FAILURES, WINDOW, LOCKOUT, type AttemptState } from "../src/ratelimit.ts";

const T = 1_800_000_000;

test("failures below the limit never lock", () => {
  let s: AttemptState | null = null;
  for (let i = 0; i < MAX_FAILURES - 1; i++) s = recordFailure(s, T + i);
  assert.equal(s!.failures, MAX_FAILURES - 1);
  assert.equal(isLocked(s, T + 100), false);
});

test("the Nth failure inside the window locks for the lockout period", () => {
  let s: AttemptState | null = null;
  for (let i = 0; i < MAX_FAILURES; i++) s = recordFailure(s, T + i);
  assert.equal(isLocked(s, T + MAX_FAILURES), true);
  assert.equal(s!.lockedUntil, T + MAX_FAILURES - 1 + LOCKOUT);
  assert.equal(retryAfter(s!, T + 100), s!.lockedUntil - (T + 100));
});

test("the lock ends on its own and the count starts over", () => {
  let s: AttemptState | null = null;
  for (let i = 0; i < MAX_FAILURES; i++) s = recordFailure(s, T);
  assert.equal(isLocked(s, T + LOCKOUT - 1), true);
  assert.equal(isLocked(s, T + LOCKOUT), false);
  const after = recordFailure(s, T + LOCKOUT + 5);
  assert.equal(after.failures, 1);
  assert.equal(after.lockedUntil, 0);
});

test("slow guessing, spread over more than one window, is not locked", () => {
  let s: AttemptState | null = null;
  for (let i = 0; i < 50; i++) s = recordFailure(s, T + i * WINDOW);
  assert.equal(s!.failures, 1);
  assert.equal(isLocked(s, T + 50 * WINDOW), false);
});

test("the window is anchored at the first failure, not extended by later ones", () => {
  let s = recordFailure(null, T);
  s = recordFailure(s, T + WINDOW - 1);
  assert.equal(s.failures, 2);
  assert.equal(s.windowStart, T);
  s = recordFailure(s, T + WINDOW);
  assert.equal(s.failures, 1); // window rolled over
});

test("an unknown address is not locked", () => {
  assert.equal(isLocked(null, T), false);
});
