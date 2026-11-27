/**
 * The eMe client: the header it authenticates with, and what it says when
 * the server refuses.
 *
 * The refusal messages are tested because they are the whole of what a user
 * sees when a first run fails, and the first run fails for one of three
 * reasons: wrong URL, wrong key, or a payload the server disliked. Telling
 * those apart from the report is the difference between a two-minute fix and
 * an evening.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { explain, upsertConversation } from "../src/eme.js";
import type { Conversation } from "../src/types.js";

const SETTINGS = { baseUrl: "https://eme.test/v2/api", apiKey: "secret", enabled: [] };

const CONVERSATION: Conversation = {
  id: "c1",
  title: "t",
  transcript: "User: hi",
  startedAt: "2026-11-15T13:00:00.000Z",
  endedAt: "2026-11-15T13:01:00.000Z",
  messageCount: 1,
  model: "grok-4",
  url: "https://grok.com/chat/c1",
};

function capture(response: Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return response;
  }) as typeof fetch;
  return calls;
}

describe("upsertConversation", () => {
  it("authenticates with X-API-Key, not a bearer token", async () => {
    // The endpoint takes either an eMe key in this header or a Supabase JWT
    // as a bearer token. A key sent as a bearer token is read as a JWT and
    // rejected, which looks like a bad key rather than a bad header.
    const calls = capture(new Response("{}", { status: 200 }));

    await upsertConversation(SETTINGS, "grok", CONVERSATION);

    const headers = calls[0]?.init.headers as Record<string, string>;
    assert.equal(headers["X-API-Key"], "secret");
    assert.ok(!("Authorization" in headers), "the key must not go out as a bearer token");
  });

  it("posts to /ingest/upsert under the configured base", async () => {
    const calls = capture(new Response("{}", { status: 200 }));

    await upsertConversation(SETTINGS, "grok", CONVERSATION);

    assert.equal(calls[0]?.url, "https://eme.test/v2/api/ingest/upsert");
  });

  it("sends no cookies", async () => {
    // eMe authenticates by the key above, never by a cookie that happens to
    // be lying around for that origin.
    const calls = capture(new Response("{}", { status: 200 }));

    await upsertConversation(SETTINGS, "grok", CONVERSATION);

    assert.equal(calls[0]?.init.credentials, "omit");
  });

  it("reports success without reading the body", async () => {
    capture(new Response("{}", { status: 200 }));

    const result = await upsertConversation(SETTINGS, "grok", CONVERSATION);

    assert.deepEqual(result, { ok: true, status: 200 });
  });

  it("explains a refusal rather than passing it through raw", async () => {
    capture(new Response("<!DOCTYPE HTML><html><title>404</title></html>", { status: 404 }));

    const result = await upsertConversation(SETTINGS, "grok", CONVERSATION);

    assert.equal(result.ok, false);
    assert.match(result.detail ?? "", /proxy or web server/);
  });
});

describe("explain", () => {
  it("names a proxy page for what it is", () => {
    // The most likely first-run failure when self-hosting behind a proxy:
    // eMe's API sits under a path prefix and the bare origin serves the web
    // client, so the obvious-looking URL reaches the wrong thing.
    const message = explain(404, '<!DOCTYPE HTML PUBLIC "-//IETF//DTD HTML 2.0//EN">\n<html>…');

    assert.match(message, /HTML page came back, not eMe/);
    assert.match(message, /missing its API path/);
  });

  it("recognises an HTML page whatever its case and leading whitespace", () => {
    assert.match(explain(404, "\n  <html><body>nope</body></html>"), /not eMe/);
  });

  it("points at the key for a 401", () => {
    assert.match(explain(401, '{"detail":"Invalid API key"}'), /rejected the API key/);
  });

  it("points at the key for a 403", () => {
    assert.match(explain(403, ""), /rejected the API key/);
  });

  it("says a rate limit will sort itself out", () => {
    // eMe's ingest limit is per user and documented to be backed off, not
    // treated as a failure.
    assert.match(explain(429, ""), /rate limit/);
    assert.match(explain(429, ""), /next sync/);
  });

  it("distinguishes a JSON 404 from eMe from a proxy's HTML one", () => {
    const message = explain(404, '{"detail":"Not Found"}');

    assert.match(message, /no \/ingest\/upsert at that URL/);
    assert.ok(!message.includes("proxy or web server"));
  });

  it("passes through an unrecognised status with its body", () => {
    assert.match(explain(422, '{"detail":[{"loc":["body","raw_json"]}]}'), /422.*raw_json/s);
  });

  it("says so when there is no body at all", () => {
    assert.match(explain(500, ""), /<no body>/);
  });

  it("caps a long body rather than filling the report with it", () => {
    const message = explain(500, "x".repeat(5_000));

    assert.ok(message.length < 400, `message was ${message.length} characters`);
  });
});
