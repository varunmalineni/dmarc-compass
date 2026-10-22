// Helpers for building Slack messages. Pure. Report data (domain names,
// reporter names) comes from third parties and can be crafted, so everything
// interpolated into mrkdwn is escaped: Slack treats <...> as links and
// mentions (<!channel>, <https://evil|click here>).

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Escapes and shortens untrusted text for inline use. */
export function safe(s: string, max = 80): string {
  const clean = s.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return esc(clean.length > max ? clean.slice(0, max - 1) + "…" : clean);
}

export function num(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

export function pct(n: number, digits = 1): string {
  return `${n.toFixed(digits)}%`;
}

export interface SlackBlock {
  type: string;
  [key: string]: unknown;
}

export interface SlackMessage {
  text: string;
  blocks: SlackBlock[];
}

const SECTION_LIMIT = 2900; // Slack caps section text at 3000 characters.

/** Joins lines into section blocks that each stay under Slack's limit. */
export function sections(lines: string[]): SlackBlock[] {
  const blocks: SlackBlock[] = [];
  let buf = "";
  for (const line of lines) {
    const piece = line.length > SECTION_LIMIT ? line.slice(0, SECTION_LIMIT - 1) + "…" : line;
    if (buf && buf.length + piece.length + 1 > SECTION_LIMIT) {
      blocks.push({ type: "section", text: { type: "mrkdwn", text: buf } });
      buf = "";
    }
    buf += (buf ? "\n" : "") + piece;
  }
  if (buf) blocks.push({ type: "section", text: { type: "mrkdwn", text: buf } });
  return blocks;
}

export function header(text: string): SlackBlock {
  return { type: "header", text: { type: "plain_text", text: text.slice(0, 150), emoji: false } };
}

export function context(text: string): SlackBlock {
  return { type: "context", elements: [{ type: "mrkdwn", text }] };
}

/** An "Open dashboard" link, only when the dashboard's address is known. */
export function linkBlock(baseUrl: string | null, path: string, label: string): SlackBlock[] {
  if (!baseUrl) return [];
  const url = baseUrl.replace(/\/$/, "") + path;
  return [{ type: "section", text: { type: "mrkdwn", text: `<${url}|${esc(label)}>` } }];
}
