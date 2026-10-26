import test from "node:test";
import assert from "node:assert/strict";
import { streamObjects } from "../src/json-stream.ts";

function bodyOf(text: string, chunk: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (i >= bytes.length) return c.close();
      c.enqueue(bytes.slice(i, i + chunk));
      i += chunk;
    },
  });
}

async function collect(text: string, chunk: number) {
  const out: unknown[] = [];
  for await (const o of streamObjects(bodyOf(text, chunk))) out.push(o);
  return out;
}

const sample = [
  { a: 1, s: 'quote " and brace } and bracket ]', nested: { x: [1, 2, { y: "}" }] } },
  { a: 2, s: "back\\slash \\\" still inside", t: "ünïcödé ✓ 日本" },
  { a: 3, empty: {}, arr: [] },
];

test("yields each object, whatever the chunk size (even one byte at a time, splitting multi-byte characters)", async () => {
  const text = JSON.stringify(sample);
  for (const size of [1, 2, 3, 7, 16, 100, 100000]) assert.deepEqual(await collect(text, size), sample, `chunk ${size}`);
});

test("pretty-printed input and an empty array", async () => {
  assert.deepEqual(await collect(JSON.stringify(sample, null, 2), 5), sample);
  assert.deepEqual(await collect("[]", 1), []);
  assert.deepEqual(await collect("  [ ]  ", 2), []);
});

test("a large list streams without trouble", async () => {
  const big = Array.from({ length: 20000 }, (_, i) => ({ hash: `h${i}`, id: `id-${i}`, org: "google.com", domain: `d${i}.example`, date_end: 1700000000 + i }));
  const got = await collect(JSON.stringify(big), 4096);
  assert.equal(got.length, 20000);
  assert.deepEqual(got[19999], big[19999]);
});
