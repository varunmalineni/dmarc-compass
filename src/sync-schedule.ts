// How often to sync. Pure, so it can be unit-tested with plain Node.
//
// The Worker wakes on a fixed fast cron tick (see wrangler.jsonc). On each tick
// it asks whether a sync is due under the interval chosen in Admin, so the
// interval can change without redeploying.

/** Seconds between cron ticks; also the finest interval that can be honoured. */
export const TICK_SECONDS = 300;
export const MIN_INTERVAL = 5;
export const MAX_INTERVAL = 1440;
export const DEFAULT_INTERVAL = 15;
export const PRESETS = [5, 10, 15, 30, 60, 120, 240, 360, 720, 1440] as const;

/** Whole minutes between MIN and MAX; anything unusable becomes the default. */
export function sanitizeInterval(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return DEFAULT_INTERVAL;
  return Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, Math.round(n)));
}

/** Is a sync due? Ticks arrive a little early or late, so half a tick of slack
 * stops a 15-minute interval from drifting to 20. */
export function syncDue(lastAttempt: number | null, intervalMinutes: number, now: number): boolean {
  if (lastAttempt === null) return true;
  return now - lastAttempt >= intervalMinutes * 60 - TICK_SECONDS / 2;
}

/** When the next sync is expected, rounded up to a tick. Null if one is due now. */
export function nextSyncAt(lastAttempt: number | null, intervalMinutes: number, now: number): number | null {
  if (syncDue(lastAttempt, intervalMinutes, now)) return null;
  const target = (lastAttempt as number) + intervalMinutes * 60 - TICK_SECONDS / 2;
  return Math.ceil(target / TICK_SECONDS) * TICK_SECONDS;
}

/** How often the parser container should re-read the mailbox while it is awake. */
export function containerIntervalSeconds(intervalMinutes: number): number {
  return Math.min(900, Math.max(300, intervalMinutes * 60));
}

/** The sync-problem alert must not fire between two healthy syncs. */
export function staleAfterSeconds(staleMinutes: number, intervalMinutes: number): number {
  return Math.max(staleMinutes * 60, 3 * intervalMinutes * 60);
}

export function intervalLabel(minutes: number): string {
  if (minutes < 60) return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  if (minutes % 60 === 0) {
    const h = minutes / 60;
    return h === 1 ? "1 hour" : `${h} hours`;
  }
  return `${minutes} minutes`;
}

/** If the cron is slower than the chosen interval, the interval cannot be met. */
export function scheduleTooSlow(observedGapSeconds: number | null, intervalMinutes: number): boolean {
  return observedGapSeconds !== null && observedGapSeconds > intervalMinutes * 60 * 1.25 && observedGapSeconds > TICK_SECONDS * 1.5;
}

/** Folds a new tick into the list of recent gaps (newest last, at most 5). A gap
 * far longer than a tick is a missed run or a pause, not the schedule, so it is
 * ignored. */
export function observeTick(prevTick: number | null, now: number, gaps: number[]): number[] {
  if (prevTick === null) return gaps;
  const gap = now - prevTick;
  if (gap <= 0 || gap > 3600 * 2) return gaps;
  return [...gaps, gap].slice(-5);
}

/** The typical gap between ticks: the median, so one missed run does not count as the schedule. */
export function typicalGap(gaps: number[]): number | null {
  if (gaps.length === 0) return null;
  const sorted = [...gaps].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
