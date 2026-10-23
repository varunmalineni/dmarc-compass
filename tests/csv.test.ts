import test from "node:test";
import assert from "node:assert/strict";
import { csvCell, csvRow, toCsv, toJsonRows, isoDate, slug, CSV_BOM } from "../src/csv.ts";

test("plain values pass through; null and undefined become empty", () => {
  assert.equal(csvCell("example.com"), "example.com");
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(undefined), "");
  assert.equal(csvCell(42), "42");
  assert.equal(csvCell(0), "0");
  assert.equal(csvCell(true), "true");
});

test("quotes, commas and newlines are quoted and escaped (RFC 4180)", () => {
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell("a,b"), '"a,b"');
  assert.equal(csvCell("line1\nline2"), '"line1\nline2"');
  assert.equal(csvCell("a\r\nb"), '"a\r\nb"');
});

test("text that would run as a spreadsheet formula is neutralised", () => {
  for (const evil of ["=1+1", "+1+1", "-1+1", "@SUM(A1)", '=HYPERLINK("http://evil.example","x")', "\tcmd", "\rcmd"]) {
    const out = csvCell(evil);
    const unquoted = out.startsWith('"') ? out.slice(1, -1) : out;
    assert.ok(unquoted.startsWith("'"), `not neutralised: ${JSON.stringify(evil)} -> ${out}`);
  }
});

test("numbers, including negatives, are never prefixed", () => {
  assert.equal(csvCell(-5), "-5");
  assert.equal(csvCell(-0.5), "-0.5");
  assert.equal(csvCell(Number.NaN), "");
  assert.equal(csvCell(Number.POSITIVE_INFINITY), "");
});

test("a value that is only dangerous in the middle is left alone", () => {
  assert.equal(csvCell("a=b"), "a=b");
  assert.equal(csvCell("mail-out.example"), "mail-out.example");
});

test("rows end with CRLF and the file starts with a byte order mark", () => {
  assert.equal(csvRow(["a", 1, null]), "a,1,\r\n");
  const csv = toCsv(["x", "y"], [["1", 2], ["=bad", 3]]);
  assert.ok(csv.startsWith(CSV_BOM + "x,y\r\n"));
  assert.ok(csv.endsWith("'=bad,3\r\n"));
});

test("a header-only file is valid for an empty result", () => {
  assert.equal(toCsv(["a", "b"], []), CSV_BOM + "a,b\r\n");
});

test("json rows are keyed by column and null-filled", () => {
  assert.deepEqual(toJsonRows(["a", "b"], [[1, 2], [3]]), [{ a: 1, b: 2 }, { a: 3, b: null }]);
});

test("isoDate formats UTC and blanks missing values", () => {
  assert.equal(isoDate(0), "");
  assert.equal(isoDate(null), "");
  assert.equal(isoDate(1767225600), "2026-01-01T00:00:00.000Z");
});

test("slug is filesystem safe", () => {
  assert.equal(slug("Nimbus Cloud!.example"), "nimbus-cloud-.example");
  assert.equal(slug("../../etc/passwd"), "etc-passwd");
  assert.equal(slug(""), "all");
  assert.equal(slug("///"), "all");
  assert.equal(slug("a".repeat(100)).length, 40);
});
