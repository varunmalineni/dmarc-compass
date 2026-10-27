// The domain filter language: conditions joined by AND / OR, in groups, with NOT. It is
// used by the filter bar, by automatic tagging rules, and by webhook routing, so it is
// written once, here, and kept free of any database or page code.
//
//   { all: [ { field: "tag", op: "has", value: "emea" },
//            { any: [ { field: "domain", op: "ends", value: ".de" },
//                     { field: "policy", op: "is_not", value: "reject" } ] } ] }
//
// "all" means every item must match (AND), "any" means at least one must (OR), and
// `not: true` on a group inverts it.

export type Field = "tag" | "domain" | "policy";

export interface Cond {
  field: Field;
  op: string;
  value?: string | string[];
}
export interface Group {
  mode: "all" | "any";
  not?: boolean;
  items: Node[];
}
export type Node = Cond | Group;

export const isGroup = (n: Node): n is Group => (n as Group).items !== undefined;

export const POLICIES = ["none", "quarantine", "reject", "unknown"] as const;

type ValueKind = "none" | "one" | "many";
interface OpInfo {
  field: Field;
  op: string;
  label: string;
  value: ValueKind;
}

export const OPS: OpInfo[] = [
  { field: "tag", op: "has", label: "has tag", value: "one" },
  { field: "tag", op: "not_has", label: "doesn't have tag", value: "one" },
  { field: "tag", op: "has_any", label: "has any of tags", value: "many" },
  { field: "tag", op: "has_all", label: "has all of tags", value: "many" },
  { field: "tag", op: "has_none", label: "has none of tags", value: "many" },
  { field: "tag", op: "any_tag", label: "has any tag", value: "none" },
  { field: "tag", op: "no_tags", label: "has no tags", value: "none" },
  { field: "domain", op: "eq", label: "equals", value: "one" },
  { field: "domain", op: "neq", label: "doesn't equal", value: "one" },
  { field: "domain", op: "contains", label: "contains", value: "one" },
  { field: "domain", op: "not_contains", label: "doesn't contain", value: "one" },
  { field: "domain", op: "starts", label: "starts with", value: "one" },
  { field: "domain", op: "ends", label: "ends with", value: "one" },
  { field: "domain", op: "in", label: "is one of", value: "many" },
  { field: "domain", op: "not_in", label: "is not one of", value: "many" },
  { field: "policy", op: "is", label: "is", value: "one" },
  { field: "policy", op: "is_not", label: "is not", value: "one" },
  { field: "policy", op: "in", label: "is one of", value: "many" },
  { field: "policy", op: "not_in", label: "is not one of", value: "many" },
];

export const FIELD_LABELS: Record<Field, string> = { tag: "Tag", domain: "Domain", policy: "Policy" };

const opInfo = (field: Field, op: string) => OPS.find((o) => o.field === field && o.op === op);

// ----------------------------------------------------------------- limits

export const MAX_DEPTH = 3;
export const MAX_NODES = 30;
export const MAX_LIST = 100;
export const MAX_VALUE = 253;
export const MAX_TAG = 32;
export const MAX_ENCODED = 2000;

// ------------------------------------------------------------ normalising

/** Lowercase letters, digits, dot, dash and underscore; up to 32 characters. Null if nothing usable is left. */
export function normalizeTag(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const t = input.trim().toLowerCase().replace(/\s+/g, "-");
  return /^[a-z0-9][a-z0-9._-]{0,31}$/.test(t) ? t : null;
}

export function normalizeDomain(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const d = input.trim().toLowerCase().replace(/\.$/, "");
  return d.length > 0 && d.length <= MAX_VALUE && !/[\s,;"'<>\\]/.test(d) && !/[\u0000-\u001f]/.test(d) ? d : null;
}

/** A real-looking host name (at least one dot). Used where text is pasted in bulk, so a stray word is caught
 * instead of becoming a "domain". */
export function looksLikeDomain(input: string): boolean {
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(input);
}

// ------------------------------------------------------------- validation

export type Parsed = { ok: true; expr: Group | null } | { ok: false; error: string };

/** Turns untrusted input (a URL, a request body, stored JSON) into a valid filter, or says what is wrong.
 * Empty groups are dropped; a filter with nothing in it is `null` ("no filter"). */
export function parseExpr(input: unknown): Parsed {
  let nodes = 0;
  const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

  function node(v: unknown, depth: number): Node | null | { error: string } {
    if (++nodes > MAX_NODES) return { error: `A filter can have at most ${MAX_NODES} conditions.` };
    if (!v || typeof v !== "object" || Array.isArray(v)) return { error: "Each filter item must be a condition or a group." };
    const o = v as Record<string, unknown>;

    if ("all" in o || "any" in o) {
      if (depth >= MAX_DEPTH) return { error: `Groups can be nested at most ${MAX_DEPTH} deep.` };
      const mode = "all" in o ? "all" : "any";
      const raw = o[mode];
      if (!Array.isArray(raw)) return { error: "A group must hold a list of items." };
      const items: Node[] = [];
      for (const r of raw) {
        const n = node(r, depth + 1);
        if (n && "error" in n) return n;
        if (n) items.push(n);
      }
      if (items.length === 0) return null;
      const g: Group = { mode, items };
      if (o.not === true) g.not = true;
      return g;
    }

    const field = o.field;
    if (field !== "tag" && field !== "domain" && field !== "policy") return { error: `Unknown field "${String(field)}".` };
    const info = typeof o.op === "string" ? opInfo(field, o.op) : undefined;
    if (!info) return { error: `"${String(o.op)}" can't be used with ${FIELD_LABELS[field].toLowerCase()}.` };

    const norm = (x: unknown): string | null => {
      if (field === "tag") return normalizeTag(x);
      if (field === "domain") return typeof x === "string" && x.trim() ? x.trim().toLowerCase().slice(0, MAX_VALUE) : null;
      const p = typeof x === "string" ? x.trim().toLowerCase() : "";
      return (POLICIES as readonly string[]).includes(p) ? p : null;
    };
    const bad = field === "tag" ? "Tags use letters, digits, dot, dash and underscore (up to 32)." : field === "policy" ? "Policy must be none, quarantine, reject or unknown." : "Enter a value.";

    if (info.value === "none") return { field, op: info.op };
    if (info.value === "one") {
      const one = Array.isArray(o.value) ? null : norm(o.value);
      return one === null ? { error: bad } : { field, op: info.op, value: one };
    }
    const arr = Array.isArray(o.value) ? o.value : typeof o.value === "string" ? o.value.split(",") : [];
    if (arr.length > MAX_LIST) return { error: `A list can have at most ${MAX_LIST} values.` };
    const values: string[] = [];
    for (const x of arr) {
      if (typeof x === "string" && !x.trim()) continue;
      const n = norm(x);
      if (n === null) return { error: bad };
      if (!values.includes(n)) values.push(n);
    }
    return values.length ? { field, op: info.op, value: values } : { error: "Enter at least one value." };
  }

  if (input === null || input === undefined) return { ok: true, expr: null };
  const top = typeof input === "object" && input !== null && !("all" in input) && !("any" in input) ? { all: [input] } : input;
  const n = node(top, 0);
  if (n === null) return { ok: true, expr: null };
  if ("error" in n) return fail(n.error);
  return { ok: true, expr: isGroup(n) ? n : { mode: "all", items: [n] } };
}

// ------------------------------------------------------------- evaluation

export interface DomainFacts {
  domain: string;
  tags: ReadonlySet<string>;
  /** The latest published policy, or null when no report has been seen. */
  policy: string | null;
}

function matches(c: Cond, d: DomainFacts): boolean {
  const one = typeof c.value === "string" ? c.value : "";
  const many = Array.isArray(c.value) ? c.value : [];
  switch (c.field) {
    case "tag":
      switch (c.op) {
        case "has": return d.tags.has(one);
        case "not_has": return !d.tags.has(one);
        case "has_any": return many.some((t) => d.tags.has(t));
        case "has_all": return many.every((t) => d.tags.has(t));
        case "has_none": return !many.some((t) => d.tags.has(t));
        case "any_tag": return d.tags.size > 0;
        case "no_tags": return d.tags.size === 0;
      }
      return false;
    case "domain": {
      const name = d.domain.toLowerCase();
      switch (c.op) {
        case "eq": return name === one;
        case "neq": return name !== one;
        case "contains": return name.includes(one);
        case "not_contains": return !name.includes(one);
        case "starts": return name.startsWith(one);
        case "ends": return name.endsWith(one);
        case "in": return many.includes(name);
        case "not_in": return !many.includes(name);
      }
      return false;
    }
    case "policy": {
      const p = d.policy ?? "unknown";
      switch (c.op) {
        case "is": return p === one;
        case "is_not": return p !== one;
        case "in": return many.includes(p);
        case "not_in": return !many.includes(p);
      }
      return false;
    }
  }
}

export function evaluate(n: Node, d: DomainFacts): boolean {
  if (!isGroup(n)) return matches(n, d);
  const r = n.mode === "all" ? n.items.every((i) => evaluate(i, d)) : n.items.some((i) => evaluate(i, d));
  return n.not ? !r : r;
}

/** How many conditions a filter has (for the badge on the Filter button). */
export function countConditions(n: Node): number {
  return isGroup(n) ? n.items.reduce((a, i) => a + countConditions(i), 0) : 1;
}

/** Which facts a filter needs, so the expensive ones (the latest policy) are only loaded when used. */
export function fieldsUsed(n: Node, into = new Set<Field>()): Set<Field> {
  if (isGroup(n)) for (const i of n.items) fieldsUsed(i, into);
  else into.add(n.field);
  return into;
}

// --------------------------------------------------------- text and codec

function describeCond(c: Cond): string {
  const info = opInfo(c.field, c.op);
  const label = info?.label ?? c.op;
  const v = Array.isArray(c.value) ? c.value.join(", ") : c.value;
  const subject = c.field === "tag" ? "" : `${FIELD_LABELS[c.field].toLowerCase()} `;
  return `${subject}${label}${v ? ` ${v}` : ""}`.trim();
}

/** A one-line description for labels and titles: "has tag emea and (domain ends with .de or policy is not reject)". */
export function describe(n: Node, top = true): string {
  if (!isGroup(n)) return describeCond(n);
  const parts = n.items.map((i) => describe(i, false));
  let text = parts.join(n.mode === "all" ? " and " : " or ");
  if (n.not) text = `not (${text})`;
  else if (!top && parts.length > 1) text = `(${text})`;
  return text;
}

/** The compact form kept in a URL's `f` parameter. */
export function encodeExpr(e: Group | null): string {
  return e ? JSON.stringify(e.not || e.items.length ? toWire(e) : {}) : "";
}

/** The plain form a filter is sent and stored in (what parseExpr reads). */
export function toWire(n: Node): unknown {
  if (!isGroup(n)) return n.value === undefined ? { field: n.field, op: n.op } : { field: n.field, op: n.op, value: n.value };
  const g: Record<string, unknown> = { [n.mode]: n.items.map(toWire) };
  if (n.not) g.not = true;
  return g;
}

/** Reads a URL's `f` parameter. Anything unusable becomes "no filter" rather than an error page. */
export function decodeExpr(text: string | null | undefined): Group | null {
  if (!text || text.length > MAX_ENCODED) return null;
  try {
    const p = parseExpr(JSON.parse(text));
    return p.ok ? p.expr : null;
  } catch {
    return null;
  }
}

/** The filter for "show me the domains with this tag". */
export const tagFilter = (tag: string): Group => ({ mode: "all", items: [{ field: "tag", op: "has", value: tag }] });
