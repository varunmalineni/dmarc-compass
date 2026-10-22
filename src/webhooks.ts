// The list of notification webhooks. Pure, so it can be unit-tested with
// plain Node. Storage and delivery live in notify.ts.

import { maskWebhook, sanitizeNickname, validateWebhookUrl } from "./notify-config.ts";

export interface Hook {
  id: string;
  /** Optional label shown in the admin UI. */
  name: string;
  url: string;
  /** Receives alerts. */
  alerts: boolean;
  /** Receives the digest. */
  digest: boolean;
}

export const MAX_HOOKS = 10;

type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

function flag(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
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
  input: { url: unknown; name?: unknown; alerts?: unknown; digest?: unknown },
  id: string,
): Result<{ list: Hook[]; hook: Hook }> {
  if (list.length >= MAX_HOOKS) return { ok: false, error: `You can have at most ${MAX_HOOKS} webhooks.` };
  if (typeof input.url !== "string" || !input.url.trim()) return { ok: false, error: "Paste the webhook URL." };
  const v = validateWebhookUrl(input.url);
  if (!v.ok) return v;
  if (list.some((h) => normalised(h.url) === v.url)) return { ok: false, error: "That webhook is already in the list." };
  const hook: Hook = {
    id,
    name: sanitizeNickname(input.name),
    url: v.url,
    alerts: flag(input.alerts, true),
    digest: flag(input.digest, true),
  };
  return { ok: true, list: [...list, hook], hook };
}

export function updateHook(
  list: Hook[],
  id: string,
  patch: { name?: unknown; alerts?: unknown; digest?: unknown },
): Result<{ list: Hook[] }> {
  if (!list.some((h) => h.id === id)) return { ok: false, error: "That webhook no longer exists." };
  return {
    ok: true,
    list: list.map((h) =>
      h.id !== id
        ? h
        : {
            ...h,
            name: patch.name === undefined ? h.name : sanitizeNickname(patch.name),
            alerts: flag(patch.alerts, h.alerts),
            digest: flag(patch.digest, h.digest),
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
    out.push({ id: h.id, name: sanitizeNickname(h.name), url: h.url, alerts: flag(h.alerts, true), digest: flag(h.digest, true) });
    if (out.length >= MAX_HOOKS) break;
  }
  return out;
}

export function receiving(kind: "alerts" | "digest", hooks: Hook[]): Hook[] {
  return hooks.filter((h) => h[kind]);
}

/** What the admin UI needs to know about a hook, without the URL. */
export interface HookView {
  id: string;
  name: string;
  masked: string;
  alerts: boolean;
  digest: boolean;
  /** "secret" hooks come from a Worker secret and cannot be edited or removed here. */
  source: "saved" | "secret";
}

export function toView(h: Hook, source: "saved" | "secret"): HookView {
  return { id: h.id, name: h.name, masked: maskWebhook(h.url), alerts: h.alerts, digest: h.digest, source };
}
