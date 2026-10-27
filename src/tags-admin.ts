// What the Admin → Tags tab can do: list and change tags, import, and manage automatic
// rules. Each action takes a request body and returns { status, body }, so app.ts only has
// to route it and the logic can be tested with plain Node.

import { describe, normalizeDomain, normalizeTag, toWire } from "./domain-filter.ts";
import {
  MAX_RULES,
  MAX_TAGS,
  MAX_TAGS_PER_DOMAIN,
  countTags,
  effectiveTags,
  isTagColor,
  leastUsedColor,
  loadColors,
  saveColors,
  TAG_COLORS,
  knownDomains,
  loadRules,
  loadTagData,
  parseImport,
  ruleTags,
  saveRules,
  validateRule,
  type Rule,
  type TagData,
} from "./tags.ts";

export const PAGE_SIZE = 50;
const MAX_TARGETS = 5000;

export interface Reply {
  status: number;
  body: unknown;
}
const fail = (error: string, status = 400): Reply => ({ status, body: { error } });
const ok = (body: Record<string, unknown> = {}): Reply => ({ status: 200, body: { ok: true, ...body } });

const str = (v: unknown) => (typeof v === "string" ? v : "");
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

function tagList(v: unknown): string[] {
  const raw = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,\s]+/) : [];
  const out: string[] = [];
  for (const x of raw) {
    const t = normalizeTag(x);
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/** Every domain worth listing: those with reports, and those only tagged so far. */
async function universe(db: D1Database, data: TagData): Promise<string[]> {
  const set = new Set(await knownDomains(db));
  for (const d of data.manual.keys()) set.add(d);
  return [...set].sort((a, b) => a.localeCompare(b));
}

export interface Selector {
  q: string;
  tag: string;
  untagged: boolean;
}

function selector(v: unknown): Selector {
  const o = obj(v);
  return { q: str(o.q).trim().toLowerCase().slice(0, 100), tag: normalizeTag(o.tag) ?? "", untagged: o.untagged === true };
}

function select(domains: string[], data: TagData, s: Selector): string[] {
  return domains.filter((d) => {
    if (s.q && !d.includes(s.q) && ![...effectiveTags(d, data)].some((t) => t.includes(s.q))) return false;
    const tags = effectiveTags(d, data);
    if (s.tag && !tags.has(s.tag)) return false;
    if (s.untagged && tags.size > 0) return false;
    return true;
  });
}

// ---------------------------------------------------------------- overview

export async function overview(db: D1Database) {
  const [data, domains, colors] = await Promise.all([loadTagData(db), knownDomains(db), loadColors(db)]);
  const all = new Set(domains);
  return {
    tags: countTags(domains, data, colors),
    palette: TAG_COLORS,
    rules: data.rules.map((r) => ({ id: r.id, tag: r.tag, expr: toWire(r.expr), text: describe(r.expr), matches: domains.filter((d) => ruleTags(d, { manual: new Map(), rules: [r] }).has(r.tag)).length })),
    domains: all.size,
    untagged: domains.filter((d) => effectiveTags(d, data).size === 0).length,
    limits: { perDomain: MAX_TAGS_PER_DOMAIN, tags: MAX_TAGS, rules: MAX_RULES },
  };
}

// ------------------------------------------------------------------- list

async function list(db: D1Database, body: Record<string, unknown>): Promise<Reply> {
  const data = await loadTagData(db);
  const s = selector(body);
  const matching = select(await universe(db, data), data, s);
  const page = Math.max(1, Math.min(10000, Math.floor(Number(body.page)) || 1));
  const rows = matching.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map((domain) => {
    const viaRule = ruleTags(domain, data);
    return { domain, tags: [...effectiveTags(domain, data)].sort().map((tag) => ({ tag, rule: viaRule.has(tag) && !data.manual.get(domain)?.has(tag) })) };
  });
  return ok({ rows, total: matching.length, page, pageSize: PAGE_SIZE });
}

// ------------------------------------------------------------------ change

async function insertTags(db: D1Database, pairs: Array<[string, string]>): Promise<void> {
  const CHUNK = 2000;
  for (let i = 0; i < pairs.length; i += CHUNK) {
    const json = JSON.stringify(pairs.slice(i, i + CHUNK).map(([d, t]) => ({ d, t })));
    await db.prepare("INSERT OR IGNORE INTO domain_tags (domain, tag) SELECT json_extract(value, '$.d'), json_extract(value, '$.t') FROM json_each(?)").bind(json).run();
  }
}

async function apply(db: D1Database, body: Record<string, unknown>): Promise<Reply> {
  const add = tagList(body.add);
  const remove = tagList(body.remove);
  if (add.length === 0 && remove.length === 0) return fail("Choose a tag to add or remove.");
  if (add.some((t) => remove.includes(t))) return fail("A tag can't be both added and removed.");

  const data = await loadTagData(db);
  let targets: string[];
  if (Array.isArray(body.domains)) {
    targets = [...new Set((body.domains as unknown[]).map(normalizeDomain).filter((d): d is string => d !== null))];
  } else {
    targets = select(await universe(db, data), data, selector(body.match));
  }
  if (targets.length === 0) return fail("No domains selected.");
  if (targets.length > MAX_TARGETS) return fail(`That is more than ${MAX_TARGETS} domains at once. Narrow the search first.`);

  // Limits: a domain keeps to 20 tags by hand, and there are at most 200 tags in all.
  const existing = new Set(data.manual.size ? [...data.manual.values()].flatMap((s) => [...s]) : []);
  for (const r of data.rules) existing.add(r.tag);
  const brandNew = add.filter((t) => !existing.has(t));
  if (existing.size + brandNew.length > MAX_TAGS) return fail(`There can be at most ${MAX_TAGS} different tags.`);

  const skippedFull: string[] = [];
  const pairs: Array<[string, string]> = [];
  for (const d of targets) {
    const have = data.manual.get(d) ?? new Set<string>();
    const fresh = add.filter((t) => !have.has(t));
    if (have.size + fresh.length > MAX_TAGS_PER_DOMAIN) {
      skippedFull.push(d);
      continue;
    }
    for (const t of add) pairs.push([d, t]);
  }
  await insertTags(db, pairs);
  await giveColors(db, existingTags(data), add);

  let removedRows = 0;
  let keptByRule = 0;
  if (remove.length) {
    const res = await db
      .prepare("DELETE FROM domain_tags WHERE domain IN (SELECT value FROM json_each(?)) AND tag IN (SELECT value FROM json_each(?))")
      .bind(JSON.stringify(targets), JSON.stringify(remove))
      .run();
    removedRows = res.meta.changes ?? 0;
    for (const d of targets) for (const t of remove) if (ruleTags(d, data).has(t)) keptByRule++;
  }
  return ok({ domains: targets.length, skippedFull: skippedFull.slice(0, 20), skippedCount: skippedFull.length, removedRows, keptByRule });
}

// ------------------------------------------------------------------ import

async function importTags(db: D1Database, body: Record<string, unknown>): Promise<Reply> {
  const text = str(body.text);
  if (text.length > 400_000) return fail("That is too much text. Import fewer lines at a time.");
  const mode = body.mode === "set" ? "set" : "add";
  const parsed = parseImport(text);
  const tags = new Set(parsed.entries.flatMap((e) => e.tags));
  const summary = { domains: parsed.entries.length, tags: tags.size, errors: parsed.errors.slice(0, 30), errorCount: parsed.errors.length };
  if (body.dryRun === true) return ok({ ...summary, dryRun: true });
  if (parsed.entries.length === 0) return fail("Nothing to import: no line had a domain and a tag.");

  const data = await loadTagData(db);
  const existing = new Set([...data.manual.values()].flatMap((s) => [...s]));
  for (const r of data.rules) existing.add(r.tag);
  if ([...tags].filter((t) => !existing.has(t)).length + existing.size > MAX_TAGS) return fail(`There can be at most ${MAX_TAGS} different tags.`);

  if (mode === "set") {
    await db.prepare("DELETE FROM domain_tags WHERE domain IN (SELECT value FROM json_each(?))").bind(JSON.stringify(parsed.entries.map((e) => e.domain))).run();
  }
  const pairs: Array<[string, string]> = [];
  for (const e of parsed.entries) {
    const have = mode === "set" ? new Set<string>() : (data.manual.get(e.domain) ?? new Set<string>());
    if (have.size + e.tags.filter((t) => !have.has(t)).length > MAX_TAGS_PER_DOMAIN) {
      summary.errors.push({ line: 0, reason: `${e.domain} would have more than ${MAX_TAGS_PER_DOMAIN} tags, so it was left as it was.` });
      summary.errorCount++;
      continue;
    }
    for (const t of e.tags) pairs.push([e.domain, t]);
  }
  await insertTags(db, pairs);
  await giveColors(db, existingTags(data), [...tags].sort());
  return ok({ ...summary, applied: true, mode });
}

// ------------------------------------------------------- rename and delete

async function rename(db: D1Database, body: Record<string, unknown>): Promise<Reply> {
  const from = normalizeTag(body.from);
  const to = normalizeTag(body.to);
  if (!from) return fail("Unknown tag.");
  if (!to) return fail("Choose a new name: letters, digits, dot, dash and underscore, up to 32 characters.");
  if (from === to) return fail("That is already its name.");
  const data = await loadTagData(db);
  const exists = (t: string) => [...data.manual.values()].some((s) => s.has(t)) || data.rules.some((r) => r.tag === t);
  if (!exists(from)) return fail("That tag no longer exists.", 404);
  const merging = exists(to);
  const colors = await loadColors(db);
  if (colors[from]) {
    // The new name keeps its own colour if it already had one (a merge); otherwise it takes this one.
    if (!colors[to]) colors[to] = colors[from];
    delete colors[from];
    await saveColors(db, colors);
  }
  await db.batch([
    // A domain that already has the new name keeps one row for it.
    db.prepare("UPDATE OR IGNORE domain_tags SET tag = ? WHERE tag = ?").bind(to, from),
    db.prepare("DELETE FROM domain_tags WHERE tag = ?").bind(from),
  ]);
  if (data.rules.some((r) => r.tag === from)) await saveRules(db, data.rules.map((r) => (r.tag === from ? { ...r, tag: to } : r)));
  return ok({ merged: merging });
}

async function remove(db: D1Database, body: Record<string, unknown>): Promise<Reply> {
  const tag = normalizeTag(body.tag);
  if (!tag) return fail("Unknown tag.");
  const rules = await loadRules(db);
  const res = await db.prepare("DELETE FROM domain_tags WHERE tag = ?").bind(tag).run();
  const kept = rules.filter((r) => r.tag !== tag);
  if (kept.length !== rules.length) await saveRules(db, kept);
  const colors = await loadColors(db);
  if (colors[tag]) {
    delete colors[tag];
    await saveColors(db, colors);
  }
  return ok({ removedFrom: res.meta.changes ?? 0, rulesRemoved: rules.length - kept.length });
}

// ------------------------------------------------------------------ colour

/** Gives each of `tags` that has no colour yet the colour least used by the tags that exist. */
async function giveColors(db: D1Database, existing: Set<string>, tags: string[]): Promise<void> {
  const colors = await loadColors(db);
  const among = new Set(existing);
  let changed = false;
  for (const t of tags) {
    among.add(t);
    if (!isTagColor(colors[t])) {
      colors[t] = leastUsedColor(colors, [...among].filter((x) => x !== t));
      changed = true;
    }
  }
  if (changed) await saveColors(db, colors);
}

const existingTags = (data: TagData) => new Set([...[...data.manual.values()].flatMap((s) => [...s]), ...data.rules.map((r) => r.tag)]);

/** Chooses a tag's colour; an empty colour means "pick one for me", which takes the least-used colour. */
async function setColor(db: D1Database, body: Record<string, unknown>): Promise<Reply> {
  const tag = normalizeTag(body.tag);
  if (!tag) return fail("Unknown tag.");
  const color = str(body.color);
  if (color !== "" && !isTagColor(color)) return fail("Choose one of the colours offered.");
  const data = await loadTagData(db);
  const exists = [...data.manual.values()].some((s) => s.has(tag)) || data.rules.some((r) => r.tag === tag);
  if (!exists) return fail("That tag no longer exists.", 404);
  const colors = await loadColors(db);
  if (color) colors[tag] = color;
  else {
    delete colors[tag];
    colors[tag] = leastUsedColor(colors, [...existingTags(data)].filter((x) => x !== tag));
  }
  await saveColors(db, colors);
  return ok({ tag, color: colors[tag] });
}

// ------------------------------------------------------------------- rules

const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, "0")).join("");

async function previewRule(db: D1Database, body: Record<string, unknown>): Promise<Reply> {
  const v = validateRule({ tag: body.tag || "preview", expr: body.expr }, "preview");
  if (!v.ok) return fail(v.error);
  const domains = await knownDomains(db);
  const hits = domains.filter((d) => ruleTags(d, { manual: new Map(), rules: [v.rule] }).size > 0);
  return ok({ matches: hits.length, sample: hits.slice(0, 12), text: describe(v.rule.expr) });
}

async function saveRule(db: D1Database, body: Record<string, unknown>): Promise<Reply> {
  const rules = await loadRules(db);
  const existing = rules.find((r) => r.id === str(body.id));
  const v = validateRule({ tag: body.tag, expr: body.expr }, existing?.id ?? newId());
  if (!v.ok) return fail(v.error);
  if (!existing && rules.length >= MAX_RULES) return fail(`There can be at most ${MAX_RULES} rules.`);
  const next: Rule[] = existing ? rules.map((r) => (r.id === existing.id ? v.rule : r)) : [...rules, v.rule];
  await saveRules(db, next);
  await giveColors(db, existingTags(await loadTagData(db)), [v.rule.tag]);
  return ok({ id: v.rule.id });
}

async function deleteRule(db: D1Database, body: Record<string, unknown>): Promise<Reply> {
  const rules = await loadRules(db);
  const next = rules.filter((r) => r.id !== str(body.id));
  if (next.length === rules.length) return fail("That rule no longer exists.", 404);
  await saveRules(db, next);
  return ok();
}

// ---------------------------------------------------------------- dispatcher

/** Handles one of the tag actions from the Admin page. Returns null for any other action. */
export async function tagsAction(db: D1Database, action: string, body: Record<string, unknown>): Promise<Reply | null> {
  switch (action) {
    case "tags_overview": return ok(await overview(db));
    case "tags_list": return list(db, body);
    case "tags_apply": return apply(db, body);
    case "tags_import": return importTags(db, body);
    case "tags_rename": return rename(db, body);
    case "tags_delete": return remove(db, body);
    case "tag_color": return setColor(db, body);
    case "tag_rule_preview": return previewRule(db, body);
    case "tag_rule_save": return saveRule(db, body);
    case "tag_rule_delete": return deleteRule(db, body);
    default: return null;
  }
}

// -------------------------------------------------------------- the export

/** Rows for the "tags" export: every known domain with its tags set by hand and from rules. */
export async function tagsExportRows(db: D1Database): Promise<Array<[string, string, string]>> {
  const data = await loadTagData(db);
  return (await universe(db, data)).map((d) => {
    const viaRule = ruleTags(d, data);
    const manual = [...(data.manual.get(d) ?? [])].sort();
    return [d, manual.join("; "), [...viaRule].filter((t) => !manual.includes(t)).sort().join("; ")];
  });
}

