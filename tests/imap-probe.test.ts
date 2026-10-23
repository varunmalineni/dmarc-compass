import test from "node:test";
import assert from "node:assert/strict";
import { quoted, plainInitialResponse, taggedStatus, existsCount, awaitingContinuation, hasUnsafeChars, friendlyError } from "../src/imap-probe.ts";

test("quoting escapes backslashes and quotes", () => {
  assert.equal(quoted('Rep"orts'), '"Rep\\"orts"');
  assert.equal(quoted("a\\b"), '"a\\\\b"');
  assert.equal(quoted("INBOX"), '"INBOX"');
});

test("PLAIN initial response is base64 of NUL user NUL password, UTF-8 safe", () => {
  assert.equal(plainInitialResponse("u", "p"), btoa("\u0000u\u0000p"));
  const b64 = plainInitialResponse("ü@example.com", "pässwörd");
  assert.equal(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))), "\u0000ü@example.com\u0000pässwörd");
});

test("tagged status is found among untagged lines, case-insensitively, and the code in brackets is dropped", () => {
  const reply = '* CAPABILITY IMAP4rev1\r\na2 OK [READ-WRITE] SELECT completed\r\n';
  assert.deepEqual(taggedStatus(reply, "a2"), { status: "OK", text: "SELECT completed" });
  assert.deepEqual(taggedStatus("a1 NO [AUTHENTICATIONFAILED] Invalid credentials\r\n", "a1"), { status: "NO", text: "Invalid credentials" });
  assert.deepEqual(taggedStatus("a1 bad nope\r\n", "a1"), { status: "BAD", text: "nope" });
  assert.equal(taggedStatus("* OK hello\r\n", "a1"), null);
  assert.equal(taggedStatus("a10 OK done\r\n", "a1"), null); // a10 is not a1
});

test("message count and continuation detection", () => {
  assert.equal(existsCount("* FLAGS (\\Seen)\r\n* 42 EXISTS\r\n* 0 RECENT\r\n"), 42);
  assert.equal(existsCount("* 0 EXISTS\r\n"), 0);
  assert.equal(existsCount("a2 NO\r\n"), null);
  assert.equal(awaitingContinuation("+ \r\n"), true);
  assert.equal(awaitingContinuation("* OK\r\n"), false);
});

test("control characters in credentials are refused rather than sent", () => {
  assert.equal(hasUnsafeChars("ok"), false);
  for (const bad of ["a\nb", "a\rb", "a\u0000b"]) assert.equal(hasUnsafeChars(bad), true);
});

test("error messages tell the admin what to check", () => {
  assert.match(friendlyError("login", { status: "NO", text: "Invalid credentials" }), /rejected the login.*Invalid credentials.*app password/);
  assert.match(friendlyError("login", { status: "NO", text: "IMAP access is disabled for your account" }), /IMAP is not enabled/);
  assert.match(friendlyError("folder", { status: "NO", text: "Mailbox doesn't exist" }), /folder could not be opened.*case-sensitive/);
});
