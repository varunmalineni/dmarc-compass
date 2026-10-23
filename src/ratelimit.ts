// Failed-login throttling. Pure, so the policy can be unit-tested; storage is
// in auth.ts. After MAX_FAILURES wrong passwords from one address inside
// WINDOW seconds, that address is locked out for LOCKOUT seconds. Only
// requests that actually carry wrong credentials count: a browser's first
// request, which has no Authorization header at all, never does.

export const MAX_FAILURES = 10;
export const WINDOW = 15 * 60;
export const LOCKOUT = 15 * 60;

export interface AttemptState {
  failures: number;
  windowStart: number;
  lockedUntil: number;
}

export const FRESH: AttemptState = { failures: 0, windowStart: 0, lockedUntil: 0 };

export function isLocked(s: AttemptState | null, now: number): boolean {
  return Boolean(s && s.lockedUntil > now);
}

export function retryAfter(s: AttemptState, now: number): number {
  return Math.max(1, s.lockedUntil - now);
}

/** State after one failed attempt at `now`. */
export function recordFailure(s: AttemptState | null, now: number): AttemptState {
  const prev = s ?? FRESH;
  // A new window starts when the old one has run out (or the lock has expired).
  const expired = now - prev.windowStart >= WINDOW || (prev.lockedUntil > 0 && prev.lockedUntil <= now);
  const failures = (expired ? 0 : prev.failures) + 1;
  const windowStart = expired ? now : prev.windowStart;
  const lockedUntil = failures >= MAX_FAILURES ? now + LOCKOUT : 0;
  return { failures, windowStart, lockedUntil };
}
