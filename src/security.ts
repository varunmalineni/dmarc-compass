// Response security headers and a Content-Security-Policy. Pure, so it can be
// unit-tested with plain Node.
//
// Scripts run only if they carry this response's random nonce (or come from
// our own origin), so markup injected through report data cannot execute even
// if some escaping were ever missed. Styles allow inline attributes because
// the pages use them; styles cannot run code.

export function newNonce(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/[+/=]/g, "");
}

export function csp(nonce: string, opts: { tiles?: boolean } = {}): string {
  return [
    "default-src 'none'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    // OpenStreetMap map tiles are the only third-party resource, and only on the map page.
    `img-src 'self' data:${opts.tiles ? " https://*.tile.openstreetmap.org" : ""}`,
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join("; ");
}

/** Adds the nonce to every <script> tag. All text that reaches the HTML from
 * outside is escaped (< becomes &lt;), so a "<script" in the output is ours. */
export function addNonce(html: string, nonce: string): string {
  return html.replace(/<script(?=[\s>])/g, `<script nonce="${nonce}"`);
}

export const BASE_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  "strict-transport-security": "max-age=31536000",
};

/** A client key for throttling: IPv4 as is, IPv6 reduced to its /64 so a
 * client cannot dodge the limit by rotating addresses inside its own prefix. */
export function clientKey(ip: string | null): string {
  if (!ip) return "unknown";
  if (!ip.includes(":")) return ip;
  const full = expandIpv6(ip);
  return full ? full.slice(0, 4).join(":") + "::/64" : ip;
}

function expandIpv6(ip: string): string[] | null {
  const [head, tail] = ip.split("::");
  const a = head ? head.split(":") : [];
  const b = tail !== undefined ? (tail ? tail.split(":") : []) : null;
  if (b === null) return a.length === 8 ? a.map((x) => x.toLowerCase().padStart(4, "0")) : null;
  const fill = 8 - a.length - b.length;
  if (fill < 0) return null;
  return [...a, ...Array(fill).fill("0"), ...b].map((x) => x.toLowerCase().padStart(4, "0"));
}

/** Compares two strings without returning early on the first difference. */
export function constantTimeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
