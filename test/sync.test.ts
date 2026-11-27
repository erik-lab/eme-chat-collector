/**
 * The sync loop, with a fake provider and a fake eMe.
 *
 * What is being checked here is mostly about failure: that a run which
 * cannot finish leaves a watermark it can resume from, and that a run which
 * fails says so.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { selectChanged, syncProvider } from "../src/sync.js";
import { ConversationNotSettled } from "../src/types.js";
import type { Conversation, ConversationSummary, ProviderAdapter } from "../src/types.js";

const SETTINGS = { baseUrl: "https://eme.test", apiKey: "k", enabled: ["fake"] };

function summary(id: string, minute: number): ConversationSummary {
  const at = `2026-11-15T13:${String(minute).padStart(2, "0")}:00.000Z`;
  return { id, title: id, createdAt: at, updatedAt: at };
}

/** Newest first, as every provider's list endpoint returns. */
const LISTED = [summary("c3", 30), summary("c2", 20), summary("c1", 10)];

function fakeAdapter(overrides: Partial<ProviderAdapter> = {}): ProviderAdapter {
  return {
    source: "fake",
    origin: "https://fake.test",
    listConversations: async () => LISTED,
    fetchConversation: async (id: string): Promise<Conversation> => ({
      id,
      title: id,
      transcript: `User: ${id}`,
      startedAt: "2026-11-15T13:00:00.000Z",
      endedAt: "2026-11-15T13:00:00.000Z",
      messageCount: 1,
      model: null,
      url: `https://fake.test/${id}`,
    }),
    ...overrides,
  };
}

/** Records what reached the server, and can be told to refuse. */
function stubFetch(responder: (url: string, body: unknown) => Response) {
  const sent: { url: string; body: unknown }[] = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "null"));
    sent.push({ url: String(url), body });
    return responder(String(url), body);
  }) as typeof fetch;
  return sent;
}

const ok = () => new Response("{}", { status: 200 });
const noSleep = async () => {};

describe("selectChanged", () => {
  it("returns everything on a first run", () => {
    assert.equal(selectChanged(LISTED, undefined).length, 3);
  });

  it("stops at the watermark instead of walking all of history", () => {
    assert.deepEqual(
      selectChanged(LISTED, "2026-11-15T13:20:00.000Z").map((s) => s.id),
      ["c3"],
    );
  });

  it("returns nothing when nothing has changed", () => {
    assert.deepEqual(selectChanged(LISTED, "2026-11-15T13:30:00.000Z"), []);
  });
});

describe("syncProvider", () => {
  beforeEach(() => {
    globalThis.fetch = (async () => ok()) as typeof fetch;
  });

  it("sends every changed conversation to /ingest/upsert", async () => {
    const sent = stubFetch(ok);

    const report = await syncProvider(fakeAdapter(), SETTINGS, { sleep: noSleep });

    assert.equal(report.sent, 3);
    assert.deepEqual(
      sent.map((s) => s.url),
      Array(3).fill("https://eme.test/ingest/upsert"),
    );
  });

  it("sends oldest first, so an interrupted run can be resumed", async () => {
    // Newest first would advance the watermark past conversations it never
    // sent, and they would never be collected at all.
    const sent = stubFetch(ok);

    await syncProvider(fakeAdapter(), SETTINGS, { sleep: noSleep });

    assert.deepEqual(
      sent.map((s) => (s.body as { id: string }).id),
      ["c1", "c2", "c3"],
    );
  });

  it("sends the payload shape eMe expects", async () => {
    const sent = stubFetch(ok);

    await syncProvider(fakeAdapter(), SETTINGS, { sleep: noSleep });

    assert.deepEqual(sent[0]?.body, {
      id: "c1",
      source: "fake",
      object_type: "conversation",
      raw_json: {
        title: "c1",
        transcript: "User: c1",
        started_at: "2026-11-15T13:00:00.000Z",
        ended_at: "2026-11-15T13:00:00.000Z",
        message_count: 1,
        model: null,
        url: "https://fake.test/c1",
      },
    });
  });

  it("stops at the conversation eMe refused, leaving it to be retried", async () => {
    stubFetch((_url, body) =>
      (body as { id: string }).id === "c2"
        ? new Response("not valid", { status: 422 })
        : ok(),
    );

    const report = await syncProvider(fakeAdapter(), SETTINGS, { sleep: noSleep });

    assert.equal(report.sent, 1);
    assert.equal(report.watermark, "2026-11-15T13:10:00.000Z", "watermark stays behind c2");
    assert.match(report.errors[0] ?? "", /c2: eMe returned 422/);
  });

  it("reports the status and cause when eMe refuses, not just a failure", async () => {
    // A 401 from a stale key and a 422 from a payload the server disliked
    // are the same colour to a user staring at "sync failed".
    stubFetch(() => new Response("key is not valid", { status: 401 }));

    const report = await syncProvider(fakeAdapter(), SETTINGS, { sleep: noSleep });

    assert.match(report.errors[0] ?? "", /401/);
    assert.match(report.errors[0] ?? "", /rejected the API key/);
    assert.match(report.errors[0] ?? "", /key is not valid/, "the server's own words survive");
  });

  it("reports a provider that failed, rather than reporting no conversations", async () => {
    const adapter = fakeAdapter({
      fetchConversation: async () => {
        throw new Error("GET /load-responses returned 404");
      },
    });

    const report = await syncProvider(adapter, SETTINGS, { sleep: noSleep });

    assert.equal(report.sent, 0);
    assert.match(report.errors[0] ?? "", /404/);
  });

  it("skips a conversation still being generated without calling it a failure", async () => {
    stubFetch(ok);
    const adapter = fakeAdapter({
      fetchConversation: async (id: string) => {
        if (id === "c2") throw new ConversationNotSettled("fake", id);
        return {
          id,
          title: id,
          transcript: `User: ${id}`,
          startedAt: "2026-11-15T13:00:00.000Z",
          endedAt: "2026-11-15T13:00:00.000Z",
          messageCount: 1,
          model: null,
          url: `https://fake.test/${id}`,
        };
      },
    });

    const report = await syncProvider(adapter, SETTINGS, { sleep: noSleep });

    assert.equal(report.sent, 1);
    assert.equal(report.skipped, 1);
    assert.deepEqual(report.errors, [], "mid-chat is not an error");
    assert.equal(report.watermark, "2026-11-15T13:10:00.000Z", "watermark stays behind c2");
  });

  it("caps a run and says it was capped", async () => {
    stubFetch(ok);

    const report = await syncProvider(fakeAdapter(), SETTINGS, {
      maxConversations: 2,
      sleep: noSleep,
    });

    assert.equal(report.sent, 2);
    assert.equal(report.truncated, true);
    assert.equal(report.watermark, "2026-11-15T13:20:00.000Z");
  });

  it("does not report a complete run as capped", async () => {
    stubFetch(ok);

    const report = await syncProvider(fakeAdapter(), SETTINGS, { sleep: noSleep });

    assert.equal(report.truncated, false);
  });

  it("paces the per-conversation fetches", async () => {
    stubFetch(ok);
    const pauses: number[] = [];

    await syncProvider(fakeAdapter(), SETTINGS, {
      delayMs: 1_500,
      sleep: async (ms) => void pauses.push(ms),
    });

    // Between fetches, not before the first: three conversations, two pauses.
    assert.deepEqual(pauses, [1_500, 1_500]);
  });

  it("makes no request at all when nothing has changed", async () => {
    const sent = stubFetch(ok);

    const report = await syncProvider(fakeAdapter(), SETTINGS, {
      since: "2026-11-15T13:30:00.000Z",
      sleep: noSleep,
    });

    assert.equal(report.changed, 0);
    assert.equal(sent.length, 0);
    assert.equal(report.watermark, "2026-11-15T13:30:00.000Z");
  });
});
