// Pure schedule math for the digest. No imports, so it can be unit-tested with
// plain Node (see tests/). Everything is epoch seconds; "local" means the
// configured IANA time zone.

export type DigestMode = "off" | "daily" | "weekly" | "monthly" | "days";

export interface DigestSchedule {
  mode: DigestMode;
  /** For mode "days": send every N days. */
  everyDays: number;
  /** For mode "weekly": 0 = Sunday .. 6 = Saturday, in the configured zone. */
  weekday: number;
  /** For mode "monthly": 1..28, so every month has the day. */
  dayOfMonth: number;
  /** Local hour of day, 0..23. */
  hour: number;
  timezone: string;
}

interface Parts {
  y: number;
  m: number;
  d: number;
  h: number;
  min: number;
  s: number;
  weekday: number;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      weekday: "short",
    });
    formatters.set(tz, f);
  }
  return f;
}

export function zonedParts(epochSeconds: number, tz: string): Parts {
  const out: Record<string, string> = {};
  for (const p of formatter(tz).formatToParts(new Date(epochSeconds * 1000))) out[p.type] = p.value;
  return {
    y: Number(out.year),
    m: Number(out.month),
    d: Number(out.day),
    h: Number(out.hour) % 24,
    min: Number(out.minute),
    s: Number(out.second),
    weekday: WEEKDAYS[out.weekday] ?? 0,
  };
}

function offsetSeconds(epochSeconds: number, tz: string): number {
  const p = zonedParts(epochSeconds, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) / 1000 - epochSeconds;
}

/** The instant at which the wall clock in `tz` reads y-m-d h:00. */
export function zonedToEpoch(y: number, m: number, d: number, h: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, h, 0, 0) / 1000;
  const first = guess - offsetSeconds(guess, tz);
  const second = guess - offsetSeconds(first, tz);
  return second;
}

/** y-m-d plus `n` calendar days, normalised. */
function addDays(y: number, m: number, d: number, n: number): { y: number; m: number; d: number } {
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

/** The most recent scheduled slot at or before `now`, for the fixed-calendar
 * modes (daily, weekly, monthly). Null for "off" and "days". */
export function latestSlot(now: number, s: DigestSchedule): number | null {
  const today = zonedParts(now, s.timezone);
  if (s.mode === "daily") {
    for (let back = 0; back <= 1; back++) {
      const day = addDays(today.y, today.m, today.d, -back);
      const slot = zonedToEpoch(day.y, day.m, day.d, s.hour, s.timezone);
      if (slot <= now) return slot;
    }
  }
  if (s.mode === "weekly") {
    for (let back = 0; back <= 7; back++) {
      const day = addDays(today.y, today.m, today.d, -back);
      const weekday = (today.weekday - back + 7 * 2) % 7;
      if (weekday !== s.weekday) continue;
      const slot = zonedToEpoch(day.y, day.m, day.d, s.hour, s.timezone);
      if (slot <= now) return slot;
    }
  }
  if (s.mode === "monthly") {
    for (let back = 0; back <= 1; back++) {
      const dt = new Date(Date.UTC(today.y, today.m - 1 - back, 1));
      const slot = zonedToEpoch(dt.getUTCFullYear(), dt.getUTCMonth() + 1, s.dayOfMonth, s.hour, s.timezone);
      if (slot <= now) return slot;
    }
  }
  return null;
}

/** The first daily slot strictly after `after`. */
function firstDailySlotAfter(after: number, s: DigestSchedule): number {
  const p = zonedParts(after, s.timezone);
  for (let fwd = 0; fwd <= 2; fwd++) {
    const day = addDays(p.y, p.m, p.d, fwd);
    const slot = zonedToEpoch(day.y, day.m, day.d, s.hour, s.timezone);
    if (slot > after) return slot;
  }
  return after + 86400;
}

/** The slot that should fire next, given the last slot already sent (or null)
 * and the moment the schedule was last (re)configured. */
export function nextSlot(s: DigestSchedule, lastSlot: number | null, enabledAt: number, now: number): number | null {
  if (s.mode === "off") return null;
  if (s.mode === "days") {
    if (lastSlot === null) return firstDailySlotAfter(enabledAt, s);
    const p = zonedParts(lastSlot, s.timezone);
    const day = addDays(p.y, p.m, p.d, Math.max(1, s.everyDays));
    return zonedToEpoch(day.y, day.m, day.d, s.hour, s.timezone);
  }
  const latest = latestSlot(now, s);
  const floor = Math.max(lastSlot ?? 0, enabledAt);
  if (latest !== null && latest > floor) return latest;
  // Nothing due yet: the next one is the first slot after `now`. Found by stepping.
  let probe = now;
  for (let i = 0; i < 40; i++) {
    probe += 86400;
    const slot = latestSlot(probe, s);
    if (slot !== null && slot > now && slot > floor) return slot;
  }
  return null;
}

/** Whether a digest should be sent right now. */
export function digestDue(s: DigestSchedule, lastSlot: number | null, enabledAt: number, now: number): { due: boolean; slot: number | null } {
  const slot = nextSlot(s, lastSlot, enabledAt, now);
  return { due: slot !== null && slot <= now, slot };
}

/** The length, in days, of the window a digest covers. */
export function digestPeriodDays(s: DigestSchedule): number {
  switch (s.mode) {
    case "daily":
      return 1;
    case "weekly":
      return 7;
    case "monthly":
      return 30;
    case "days":
      return Math.max(1, s.everyDays);
    default:
      return 7;
  }
}
