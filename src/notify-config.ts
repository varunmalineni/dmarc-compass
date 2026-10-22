// Notification settings: types, defaults and input sanitising. Pure (no
// Worker APIs) so it can be unit-tested with plain Node.

import type { DigestSchedule, DigestMode } from "./digest-schedule";

export interface NotifyConfig {
  rules: {
    /** A source that fails DMARC for a domain it has not been seen on before. */
    newFailingSender: { on: boolean; minMessages: number };
    /** A domain's pass rate fell compared with the previous period. */
    passRateDrop: { on: boolean; points: number; minMessages: number };
    /** A domain's published policy (p= or pct=) changed. */
    policyChange: { on: boolean };
    /** Syncing is failing or has stopped. */
    syncHealth: { on: boolean; staleMinutes: number };
  };
  digest: DigestSchedule;
}

export const DEFAULT_CONFIG: NotifyConfig = {
  rules: {
    newFailingSender: { on: true, minMessages: 20 },
    passRateDrop: { on: true, points: 5, minMessages: 100 },
    policyChange: { on: true },
    syncHealth: { on: true, staleMinutes: 90 },
  },
  // Off until the admin turns it on.
  digest: { mode: "off", everyDays: 7, weekday: 1, dayOfMonth: 1, hour: 9, timezone: "UTC" },
};

const MODES: DigestMode[] = ["off", "daily", "weekly", "monthly", "days"];

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function int(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Turns untrusted input (a request body or stored JSON) into a valid config.
 * Never throws: anything missing or out of range falls back to the default or
 * is clamped, so a bad value can never break the scheduler. */
export function sanitizeConfig(input: unknown): NotifyConfig {
  const d = DEFAULT_CONFIG;
  const root = obj(input);
  const r = obj(root.rules);
  const nfs = obj(r.newFailingSender);
  const drop = obj(r.passRateDrop);
  const pol = obj(r.policyChange);
  const sync = obj(r.syncHealth);
  const dg = obj(root.digest);

  const mode = MODES.includes(dg.mode as DigestMode) ? (dg.mode as DigestMode) : d.digest.mode;
  return {
    rules: {
      newFailingSender: {
        on: bool(nfs.on, d.rules.newFailingSender.on),
        minMessages: int(nfs.minMessages, 1, 1_000_000, d.rules.newFailingSender.minMessages),
      },
      passRateDrop: {
        on: bool(drop.on, d.rules.passRateDrop.on),
        points: int(drop.points, 1, 100, d.rules.passRateDrop.points),
        minMessages: int(drop.minMessages, 1, 1_000_000, d.rules.passRateDrop.minMessages),
      },
      policyChange: { on: bool(pol.on, d.rules.policyChange.on) },
      syncHealth: {
        on: bool(sync.on, d.rules.syncHealth.on),
        staleMinutes: int(sync.staleMinutes, 30, 10_080, d.rules.syncHealth.staleMinutes),
      },
    },
    digest: {
      mode,
      everyDays: int(dg.everyDays, 1, 365, d.digest.everyDays),
      weekday: int(dg.weekday, 0, 6, d.digest.weekday),
      // 1..28 so every month has the day.
      dayOfMonth: int(dg.dayOfMonth, 1, 28, d.digest.dayOfMonth),
      hour: int(dg.hour, 0, 23, d.digest.hour),
      timezone: isValidTimeZone(dg.timezone) ? dg.timezone : d.digest.timezone,
    },
  };
}

/** A Slack incoming-webhook style URL: https only, no credentials in the URL. */
export function validateWebhookUrl(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { ok: false, error: "That is not a valid URL." };
  }
  // Plain http is only accepted for loopback, so a local fake webhook can be used in development.
  const loopback = u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]");
  if (u.protocol !== "https:" && !loopback) return { ok: false, error: "The webhook URL must start with https://." };
  if (u.username || u.password) return { ok: false, error: "The webhook URL must not contain a username or password." };
  if (raw.length > 500) return { ok: false, error: "That URL is too long." };
  return { ok: true, url: u.toString() };
}

/** A form of the webhook URL that is safe to display: the host and the last
 * four characters, so the admin can tell which one is connected without the
 * credential being revealed. */
export function maskWebhook(url: string): string {
  try {
    const u = new URL(url);
    const tail = url.replace(/[?#].*$/, "").replace(/\/$/, "").slice(-4);
    return `${u.protocol}//${u.host}/••••${tail}`;
  } catch {
    return "••••";
  }
}

/** A short label for the webhook, shown in the admin UI. */
export function sanitizeNickname(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
}
