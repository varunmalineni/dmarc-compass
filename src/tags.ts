// Domain tags: the stored labels, the automatic rules, and turning a filter into the list
// of domains it matches. The pure parts (rules, import text, combining tags) have no
// database in them so they can be unit-tested with plain Node.

import { getAppSetting, setAppSetting } from "./app-settings.ts";
import { parseFilters, type Filters } from "./filters.ts";
import { evaluate, fieldsUsed, looksLikeDomain, normalizeDomain, normalizeTag, parseExpr, isGroup, toWire, type Group, type Node } from "./domain-filter.ts";

export const MAX_TAGS_PER_DOMAIN = 20;
export const MAX_TAGS = 200;
export const MAX_RULES = 50;
export const MAX_IMPORT_LINES = 5000;

// ------------------------------------------------------------------ rules

export interface Rule {
  id: string;
  /** The tag every matching domain gets. */
  tag: string;
  /** Matches on the domain name only. */
  expr: Group;
}

/** Rules look at the domain name only. A rule that reads tags or policies would make a domain's
 * tags depend on its tags, or change every time a policy does. */
function usesOnlyDomain(n: Node): boolean {
  return isGroup(n) ? n.items.every(usesOnlyDomain) : n.field === "domain";
}

export type RuleResult = { ok: true; rule: Rule } | { ok: false; error: string };

export function validateRule(input: unknown, id: string): RuleResult {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const tag = normalizeTag(o.tag);
  if (!tag) return { ok: false, error: "Choose a tag name: letters, digits, dot, dash and underscore, up to 32 characters." };
  const parsed = parseExpr(o.expr);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  if (!parsed.expr) return { ok: false, error: "Add at least one condition. A rule with none would tag every domain." };
  if (!usesOnlyDomain(parsed.expr)) return { ok: false, error: "A rule can only look at the domain name. To use tags or policies, filter the pages instead." };
  return { ok: true, rule: { id, tag, expr: parsed.expr } };
}

export function parseRules(text: string | null): Rule[] {
  if (!text) return [];
  try {
    const arr = JSON.parse(text);
    if (!Array.isArray(arr)) return [];
    const out: Rule[] = [];
    for (const r of arr.slice(0, MAX_RULES)) {
      const v = validateRule(r, typeof r?.id === "string" ? r.id : "");
      if (v.ok && v.rule.id) out.push(v.rule);
    }
    return out;
  } catch {
    return [];
  }
}

// ------------------------------------------------------------- tag sets

export interface TagData {
  manual: Map<string, Set<string>>;
  rules: Rule[];
}

const NO_TAGS: ReadonlySet<string> = new Set();

/** Every tag a domain has: the ones set by hand, and the ones its name earns from the rules. */
export function effectiveTags(domain: string, data: TagData): Set<string> {
  const out = new Set(data.manual.get(domain) ?? NO_TAGS);
  for (const r of data.rules) if (evaluate(r.expr, { domain, tags: NO_TAGS, policy: null })) out.add(r.tag);
  return out;
}

/** Which of a domain's tags come from rules rather than by hand. */
export function ruleTags(domain: string, data: TagData): Set<string> {
  const out = new Set<string>();
  for (const r of data.rules) if (evaluate(r.expr, { domain, tags: NO_TAGS, policy: null })) out.add(r.tag);
  return out;
}

// ----------------------------------------------------------------- import

export interface ImportEntry {
  domain: string;
  tags: string[];
}
export interface ImportResult {
  entries: ImportEntry[];
  errors: Array<{ line: number; reason: string }>;
}

/** Reads pasted or uploaded text: one domain per line, then its tags, separated by commas, semicolons,
 * tabs or spaces ("example.com, emea, prod"). A first line starting "domain" is a header and is skipped.
 * A domain on several lines gets all the tags. */
export function parseImport(text: string): ImportResult {
  const entries = new Map<string, Set<string>>();
  const errors: ImportResult["errors"] = [];
  const lines = text.split(/\r?\n/);
  if (lines.length > MAX_IMPORT_LINES) errors.push({ line: MAX_IMPORT_LINES + 1, reason: `Only the first ${MAX_IMPORT_LINES} lines are read.` });
  lines.slice(0, MAX_IMPORT_LINES).forEach((raw, i) => {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) return;
    const parts = line.split(/[\s,;|]+/).filter(Boolean);
    if (i === 0 && /^domains?$/i.test(parts[0])) return;
    const domain = normalizeDomain(parts[0]);
    if (!domain || !looksLikeDomain(domain)) return void errors.push({ line: i + 1, reason: `"${parts[0].slice(0, 40)}" is not a domain name.` });
    const tags: string[] = [];
    for (const t of parts.slice(1)) {
      const n = normalizeTag(t);
      if (!n) return void errors.push({ line: i + 1, reason: `"${t.slice(0, 40)}" is not a valid tag.` });
      tags.push(n);
    }
    if (tags.length === 0) return void errors.push({ line: i + 1, reason: `${domain} has no tags on the line.` });
    const set = entries.get(domain) ?? new Set<string>();
    tags.forEach((t) => set.add(t));
    if (set.size > MAX_TAGS_PER_DOMAIN) return void errors.push({ line: i + 1, reason: `${domain} would have more than ${MAX_TAGS_PER_DOMAIN} tags.` });
    entries.set(domain, set);
  });
  return { entries: [...entries].map(([domain, tags]) => ({ domain, tags: [...tags].sort() })), errors };
}

// ---------------------------------------------------------------- storage

const RULES_KEY = "tag_rules";

export async function loadRules(db: D1Database): Promise<Rule[]> {
  return parseRules(await getAppSetting(db, RULES_KEY));
}

export async function saveRules(db: D1Database, rules: Rule[]): Promise<void> {
  await setAppSetting(db, RULES_KEY, JSON.stringify(rules.map((r) => ({ id: r.id, tag: r.tag, expr: toWire(r.expr) }))));
}

export async function loadTagData(db: D1Database): Promise<TagData> {
  const [rows, rules] = await Promise.all([db.prepare("SELECT domain, tag FROM domain_tags").all<{ domain: string; tag: string }>(), loadRules(db)]);
  const manual = new Map<string, Set<string>>();
  for (const r of rows.results) {
    const set = manual.get(r.domain);
    if (set) set.add(r.tag);
    else manual.set(r.domain, new Set([r.tag]));
  }
  return { manual, rules };
}

/** Every domain the dashboard knows about: those with DMARC or TLS reports. */
export async function knownDomains(db: D1Database): Promise<string[]> {
  const res = await db
    .prepare(
      `SELECT domain FROM dmarc_reports
       UNION SELECT policy_domain FROM tls_policy_results
       ORDER BY 1 COLLATE NOCASE`,
    )
    .all<{ domain: string }>();
  return res.results.map((r) => r.domain);
}

/** The latest published policy for each domain (or none seen). */
async function latestPolicies(db: D1Database): Promise<Map<string, string | null>> {
  const res = await db
    .prepare(
      `SELECT rep.domain AS domain, MAX(rep.policy_p) AS policy
         FROM dmarc_reports rep
         JOIN (SELECT domain, MAX(date_end) AS m FROM dmarc_reports GROUP BY domain) x
           ON x.domain = rep.domain AND x.m = rep.date_end
        GROUP BY rep.domain`,
    )
    .all<{ domain: string; policy: string | null }>();
  return new Map(res.results.map((r) => [r.domain, r.policy]));
}

/** The domains a filter matches, out of those the dashboard knows. `null` means no filter. An empty
 * list means a filter that matches nothing, which is a real answer ("no domain has this tag"). */
export async function resolveScope(db: D1Database, expr: Group | null): Promise<string[] | null> {
  if (!expr) return null;
  const used = fieldsUsed(expr);
  const [domains, data, policies] = await Promise.all([
    knownDomains(db),
    used.has("tag") ? loadTagData(db) : Promise.resolve<TagData>({ manual: new Map(), rules: [] }),
    used.has("policy") ? latestPolicies(db) : Promise.resolve(new Map<string, string | null>()),
  ]);
  return domains.filter((domain) => evaluate(expr, { domain, tags: used.has("tag") ? effectiveTags(domain, data) : NO_TAGS, policy: policies.get(domain) ?? null }));
}

// ----------------------------------------------------------------- colours

/** The colours a tag can have. Names, not codes: the page styles them for both themes. */
export const TAG_COLORS = ["red", "orange", "amber", "green", "teal", "blue", "indigo", "purple", "pink", "gray"] as const;
export type TagColor = (typeof TAG_COLORS)[number];

export const isTagColor = (v: unknown): v is TagColor => typeof v === "string" && (TAG_COLORS as readonly string[]).includes(v);

/** The colour used the least among `among`, so each new tag stands apart from the existing ones
 * (the first ten tags all differ). Ties go to the earlier colour in the palette. */
export function leastUsedColor(colors: Record<string, string>, among: Iterable<string>): TagColor {
  const used = new Map<string, number>(TAG_COLORS.map((c) => [c, 0]));
  for (const tag of among) if (isTagColor(colors[tag])) used.set(colors[tag], (used.get(colors[tag]) ?? 0) + 1);
  let best: TagColor = TAG_COLORS[0];
  for (const c of TAG_COLORS) if ((used.get(c) ?? 0) < (used.get(best) ?? 0)) best = c;
  return best;
}

/** A colour from the name alone: used only for a tag that has no stored colour (one made before colours existed). */
export function autoColor(tag: string): TagColor {
  let h = 2166136261;
  for (let i = 0; i < tag.length; i++) h = Math.imul(h ^ tag.charCodeAt(i), 16777619);
  return TAG_COLORS[(h >>> 0) % TAG_COLORS.length];
}

export const colorOf = (tag: string, chosen: Record<string, string>): TagColor => (isTagColor(chosen[tag]) ? chosen[tag] : autoColor(tag)) as TagColor;

export function parseColors(text: string | null): Record<string, TagColor> {
  if (!text) return {};
  try {
    const v = JSON.parse(text);
    const out: Record<string, TagColor> = {};
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [k, c] of Object.entries(v)) if (normalizeTag(k) === k && isTagColor(c)) out[k] = c;
    }
    return out;
  } catch {
    return {};
  }
}

const COLORS_KEY = "tag_colors";
export const loadColors = async (db: D1Database) => parseColors(await getAppSetting(db, COLORS_KEY));
export const saveColors = (db: D1Database, colors: Record<string, string>) => setAppSetting(db, COLORS_KEY, JSON.stringify(colors));

export interface TagCount {
  tag: string;
  count: number;
  byRule: number;
  /** The colour shown. */
  color: TagColor;
  /** False for an old tag that has no stored colour yet and shows the one from its name. */
  chosen: boolean;
}

/** All tags in use with how many known domains carry each, for the filter and the Admin list. */
export async function tagCounts(db: D1Database): Promise<TagCount[]> {
  const [domains, data, colors] = await Promise.all([knownDomains(db), loadTagData(db), loadColors(db)]);
  return countTags(domains, data, colors);
}

export function countTags(domains: string[], data: TagData, colors: Record<string, string> = {}): TagCount[] {
  const known = new Set(domains);
  const total = new Map<string, number>();
  const viaRule = new Map<string, number>();
  for (const d of domains) {
    for (const t of effectiveTags(d, data)) total.set(t, (total.get(t) ?? 0) + 1);
    for (const t of ruleTags(d, data)) viaRule.set(t, (viaRule.get(t) ?? 0) + 1);
  }
  // Tags that exist only on domains that have not reported yet still show up, with a count of zero.
  for (const [d, tags] of data.manual) if (!known.has(d)) for (const t of tags) if (!total.has(t)) total.set(t, 0);
  for (const r of data.rules) if (!total.has(r.tag)) total.set(r.tag, 0);
  return [...total].map(([tag, count]) => ({ tag, count, byRule: viaRule.get(tag) ?? 0, color: colorOf(tag, colors), chosen: isTagColor(colors[tag]) })).sort((a, b) => a.tag.localeCompare(b.tag));
}

/** The filters for a request: read from the URL, with the tag filter worked out into a list of domains. */
export async function loadFilters(db: D1Database, url: URL): Promise<Filters> {
  const f = parseFilters(url);
  return f.expr ? { ...f, scope: await resolveScope(db, f.expr) } : f;
}
