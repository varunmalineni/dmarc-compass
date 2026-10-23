// Stored sync schedule state (plain app settings; none of it is secret).

import { getAppSetting, setAppSetting } from "./app-settings.ts";
import { observeTick, sanitizeInterval, typicalGap } from "./sync-schedule.ts";

export async function getSyncMinutes(db: D1Database): Promise<number> {
  return sanitizeInterval(await getAppSetting(db, "sync_interval_minutes"));
}

export async function setSyncMinutes(db: D1Database, minutes: unknown): Promise<number> {
  const m = sanitizeInterval(minutes);
  await setAppSetting(db, "sync_interval_minutes", String(m));
  return m;
}

async function num(db: D1Database, key: string): Promise<number | null> {
  const v = await getAppSetting(db, key);
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** When a sync last started, whether it was scheduled or run by hand. */
export const getLastAttempt = (db: D1Database) => num(db, "sync_last_attempt");
export const markAttempt = (db: D1Database, now: number) => setAppSetting(db, "sync_last_attempt", String(now));

/** Remembers when the cron ticked and how far apart recent ticks were. The typical
 * gap tells Admin whether the deployed schedule can honour the chosen interval. */
export async function recordTick(db: D1Database, now: number): Promise<void> {
  const prev = await num(db, "cron_last");
  let gaps: number[] = [];
  try {
    const parsed = JSON.parse((await getAppSetting(db, "cron_gaps")) ?? "[]");
    if (Array.isArray(parsed)) gaps = parsed.filter((g) => typeof g === "number");
  } catch {
    // start over
  }
  await setAppSetting(db, "cron_last", String(now));
  await setAppSetting(db, "cron_gaps", JSON.stringify(observeTick(prev, now, gaps)));
}

export async function getTickGap(db: D1Database): Promise<number | null> {
  try {
    const parsed = JSON.parse((await getAppSetting(db, "cron_gaps")) ?? "[]");
    return Array.isArray(parsed) ? typicalGap(parsed.filter((g) => typeof g === "number")) : null;
  } catch {
    return null;
  }
}
