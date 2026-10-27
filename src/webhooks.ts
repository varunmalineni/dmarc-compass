// The list of notification webhooks. Pure, so it can be unit-tested with
// plain Node. Storage and delivery live in notify.ts.

import { maskWebhook, sanitizeNickname, validateWebhookUrl } from "./notify-config.ts";
import { describe, parseExpr, toWire, type Group } from "./domain-filter.ts";

export type HookType = "slack" | "json";

export interface Hook {
  id: string;
  /** Slack-compatible message blocks, or a plain JSON document. */
  type: HookType;
  /** Optional label shown in the admin UI. */
  name: string;
  url: string;
  /** JSON webhooks only: HMAC key used to sign each request. Empty means unsigned. */
  secret: string;
  /** Receives alerts. */
  alerts: boolean;
  /** Receives the digest. */
  digest: boolean;
  /** Only domains matching this get to this webhook (alerts and digest). null means every domain. */
  filter: Group | null;
}

export const MAX_HOOKS = 10;

type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

function flag(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

const MAX_SECRET = 200;

function kind(v: unknown, fallback: HookType = "slack"): HookType {
  return v === "json" || v === "slack" ? v : fallback;
}

function secretOf(v: unknown): string {
  return typeof v === "string" ? v.trim().slice(0, MAX_SECRET) : "";
}

/** Reads a filter from a request or from storage. Empty or missing means no filter. */
function filterOf(v: unknown): Result<{ filter: Group | null }> {
  if (v === undefined || v === null || v === "") return { ok: true, filter: null };
  const p = parseExpr(v);
  return p.ok ? { ok: true, filter: p.expr } : { ok: false, error: p.error };
}

function normalised(url: string): string {
  try {
    return new URL(url).toString();
  } catch {
    return url;
  }
}

export function addHook(
  list: Hook[],
  input: { url: unknown; name?: unknown; type?: unknown; secret?: unknown; alerts?: unknown; digest?: unknown; filter?: unknown },
  id: string,
): Result<{ list: Hook[]; hook: Hook }> {
  if (list.length >= MAX_HOOKS) return { ok: false, error: `You can have at most ${MAX_HOOKS} webhooks.` };
  if (typeof input.url !== "string" || !input.url.trim()) return { ok: false, error: "Paste the webhook URL." };
  const v = validateWebhookUrl(input.url);
  if (!v.ok) return v;
  if (list.some((h) => normalised(h.url) === v.url)) return { ok: false, error: "That webhook is already in the list." };
  const f = filterOf(input.filter);
  if (!f.ok) return f;
  const type = kind(input.type);
  const hook: Hook = {
    id,
    type,
    name: sanitizeNickname(input.name),
    url: v.url,
    secret: type === "json" ? secretOf(input.secret) : "",
    alerts: flag(input.alerts, true),
    digest: flag(input.digest, true),
    filter: f.filter,
  };
  return { ok: true, list: [...list, hook], hook };
}

export function updateHook(
  list: Hook[],
  id: string,
  patch: { name?: unknown; secret?: unknown; alerts?: unknown; digest?: unknown; filter?: unknown },
): Result<{ list: Hook[] }> {
  if (!list.some((h) => h.id === id)) return { ok: false, error: "That webhook no longer exists." };
  // undefined keeps the current filter; null or an empty one removes it.
  const f = patch.filter === undefined ? null : filterOf(patch.filter);
  if (f && !f.ok) return f;
  return {
    ok: true,
    list: list.map((h) =>
      h.id !== id
        ? h
        : {
            ...h,
            name: patch.name === undefined ? h.name : sanitizeNickname(patch.name),
            // undefined keeps the current secret; an empty string removes it. Slack hooks have none.
            secret: h.type !== "json" || patch.secret === undefined ? h.secret : secretOf(patch.secret),
            alerts: flag(patch.alerts, h.alerts),
            digest: flag(patch.digest, h.digest),
            filter: f && f.ok ? f.filter : h.filter,
          },
    ),
  };
}

export function removeHook(list: Hook[], id: string): Hook[] {
  return list.filter((h) => h.id !== id);
}

/** Reads a stored list. Anything malformed is skipped rather than throwing, so
 * one bad entry can never take notifications down. */
export function parseHooks(json: string): Hook[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: Hook[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const h = item as Record<string, unknown>;
    if (typeof h.id !== "string" || !h.id || seen.has(h.id)) continue;
    if (typeof h.url !== "string" || !validateWebhookUrl(h.url).ok) continue;
    seen.add(h.id);
    const type = kind(h.type);
    out.push({
      id: h.id,
      type,
      name: sanitizeNickname(h.name),
      url: h.url,
      secret: type === "json" ? secretOf(h.secret) : "",
      alerts: flag(h.alerts, true),
      digest: flag(h.digest, true),
      // A filter that no longer reads matches nothing, rather than widening what the hook sends.
      filter: stored(h.filter),
    });
    if (out.length >= MAX_HOOKS) break;
  }
  return out;
}

/** A stored filter. One that is damaged reads as "matches nothing" so a hook never starts sending more than intended. */
function stored(v: unknown): Group | null {
  const f = filterOf(v);
  if (f.ok) return f.filter;
  return NOTHING;
}

/** A filter no domain satisfies (no real domain is named "-"). */
const NOTHING: Group = { mode: "all", items: [{ field: "domain", op: "eq", value: "-" }] };

/** The list as stored. Filters are written in their plain form, which parseHooks reads back. */
export function serializeHooks(list: Hook[]): string {
  return JSON.stringify(list.map((h) => ({ ...h, filter: h.filter ? toWire(h.filter) : null })));
}

export function receiving(kind: "alerts" | "digest", hooks: Hook[]): Hook[] {
  return hooks.filter((h) => h[kind]);
}

/** What the admin UI needs to know about a hook, without the URL. */
export interface HookView {
  id: string;
  type: HookType;
  name: string;
  /** Whether requests are signed. The secret itself is never exposed. */
  signed: boolean;
  masked: string;
  alerts: boolean;
  digest: boolean;
  /** The filter in the form the builder reads and writes, and the same in words. null: every domain. */
  filter: unknown;
  filterText: string | null;
  /** "secret" hooks come from a Worker secret and cannot be edited or removed here. */
  source: "saved" | "secret";
}

export function toView(h: Hook, source: "saved" | "secret"): HookView {
  return { id: h.id, type: h.type, name: h.name, signed: Boolean(h.secret), masked: maskWebhook(h.url), alerts: h.alerts, digest: h.digest, filter: h.filter ? toWire(h.filter) : null, filterText: h.filter ? describe(h.filter) : null, source };
}
