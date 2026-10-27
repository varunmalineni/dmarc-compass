// Which webhook gets which alert. Pure, so it can be unit-tested with plain Node.
//
// Webhooks with the same filter are one group. A group has a scope: the domains its filter matches,
// or null for "every domain". An alert reaches a group when it belongs to one of the scope's
// domains. Alerts about no particular domain (the sync health ones) reach every group.

import { encodeExpr, type Group } from "./domain-filter.ts";

export interface HookLike {
  id: string;
  filter: Group | null;
}

export interface RouteGroup<H extends HookLike> {
  /** Same for the same filter. "" for no filter. */
  key: string;
  filter: Group | null;
  hooks: H[];
}

export const filterKey = (g: Group | null): string => encodeExpr(g);

/** Hooks with identical filters, together. The groups keep the order the hooks were in. */
export function groupByFilter<H extends HookLike>(hooks: H[]): RouteGroup<H>[] {
  const out = new Map<string, RouteGroup<H>>();
  for (const h of hooks) {
    const key = filterKey(h.filter);
    const g = out.get(key);
    if (g) g.hooks.push(h);
    else out.set(key, { key, filter: h.filter, hooks: [h] });
  }
  return [...out.values()];
}

export interface AlertLike {
  key: string;
  data: Record<string, unknown>;
}

/** The domain an alert is about, if it is about one. */
export const alertDomain = (a: AlertLike): string | null => (typeof a.data.domain === "string" ? a.data.domain : null);

export function inScope(a: AlertLike, scope: ReadonlySet<string> | null): boolean {
  if (scope === null) return true;
  const d = alertDomain(a);
  return d === null || scope.has(d);
}

export interface Plan<A extends AlertLike, G> {
  /** What to send to each group (groups with nothing to receive are left out). */
  sends: Array<{ group: G; alerts: A[] }>;
}

export function planAlerts<A extends AlertLike, G>(alerts: A[], groups: Array<{ group: G; scope: ReadonlySet<string> | null }>): Plan<A, G> {
  const sends: Plan<A, G>["sends"] = [];
  for (const { group, scope } of groups) {
    const mine = alerts.filter((a) => inScope(a, scope));
    if (mine.length) sends.push({ group, alerts: mine });
  }
  return { sends };
}

export interface Outcome<A extends AlertLike> {
  /** Delivered somewhere, or wanted by nobody: never offered again. */
  done: A[];
  /** Wanted but not delivered anywhere: to be tried again on the next run. */
  retry: A[];
}

/** `delivered` holds the keys of the alerts that reached at least one webhook. */
export function settle<A extends AlertLike>(alerts: A[], plan: Plan<A, unknown>, delivered: ReadonlySet<string>): Outcome<A> {
  const wanted = new Set(plan.sends.flatMap((s) => s.alerts.map((a) => a.key)));
  const done: A[] = [];
  const retry: A[] = [];
  for (const a of alerts) {
    if (!wanted.has(a.key) || delivered.has(a.key)) done.push(a);
    else retry.push(a);
  }
  return { done, retry };
}

/** A line saying whose data a message holds, or null when it holds everyone's. */
export function scopeLine(filterText: string | null, domains?: number): string | null {
  if (!filterText) return null;
  return `Only domains where ${filterText}${domains === undefined ? "" : ` (${domains} ${domains === 1 ? "domain" : "domains"} now)`}`;
}
