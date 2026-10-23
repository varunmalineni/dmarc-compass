// Request signing for JSON webhooks. Pure (Web Crypto only), so it can be
// unit-tested with plain Node.
//
// The signature covers the timestamp as well as the body, so a captured request
// cannot be replayed later: receivers should reject timestamps that are too old.
//
//   signature = hex( HMAC-SHA256( secret, "<timestamp>.<body>" ) )
//   header    = X-Dmarc-Compass-Signature: sha256=<signature>

const enc = new TextEncoder();

export async function signPayload(secret: string, timestamp: number, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${timestamp}.${body}`)));
  return Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Headers for a JSON webhook delivery. */
export async function webhookHeaders(event: string, body: string, secret: string, now = Math.floor(Date.now() / 1000)): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "dmarc-compass",
    "x-dmarc-compass-event": event,
    "x-dmarc-compass-timestamp": String(now),
  };
  if (secret) headers["x-dmarc-compass-signature"] = `sha256=${await signPayload(secret, now, body)}`;
  return headers;
}
