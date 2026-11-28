/**
 * The sync loop, with a fake provider and a fake eMe.
 *
 * What is being checked here is mostly about failure: that a run which
 * cannot finish leaves a watermark it can resume from, and that a run which
 * fails says so.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { disablePacingForTests } from "../src/pace.js";
import { selectChanged, syncProvider } from "../src/sync.js";

// Real waits would make this suite take minutes. The pacing itself is
// tested by its own assertions, not by sitting through it.
disablePacingForTests();
import {
  ConversationEmpty,
  ConversationNotSettled,
  ProviderRequestError,
  ProviderShapeError,
} from "../src/types.js";
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

  it("reports the turn count of everything it sent, largest first", async () => {
    // A diagnostic for a cap. Every provider might be returning the tail the
    // UI needs rather than the whole conversation, and the tell is several
    // conversations reporting the same round number.
    stubFetch(ok);
    const counts: Record<string, number> = { c1: 4, c2: 50, c3: 12 };
    const adapter = fakeAdapter({
      fetchConversation: async (id: string) => ({
        id,
        title: id,
        transcript: `User: ${id}`,
        startedAt: "2026-11-15T13:00:00.000Z",
        endedAt: "2026-11-15T13:00:00.000Z",
        messageCount: counts[id] ?? 0,
        model: null,
        url: `https://fake.test/${id}`,
      }),
    });

    const report = await syncProvider(adapter, SETTINGS, { sleep: noSleep });

    assert.deepEqual(report.messageCounts, [50, 12, 4]);
  });

  it("counts only what was actually stored", async () => {
    // A conversation eMe refused is not in the index, so counting it would
    // make the diagnostic lie about what is there.
    stubFetch((_url, body) =>
      (body as { id: string }).id === "c2" ? new Response("no", { status: 422 }) : ok(),
    );

    const report = await syncProvider(fakeAdapter(), SETTINGS, { sleep: noSleep });

    assert.equal(report.messageCounts.length, 1);
  });

  it("steps over a conversation it cannot read and collects the rest", async () => {
    // The first real ChatGPT sync listed 761 conversations, hit a payload it
    // could not represent on the OLDEST one, and stored NOTHING. A single
    // record held an entire history hostage, and the report said sent: 0
    // with one error — accurate, and useless.
    stubFetch(ok);
    const adapter = fakeAdapter({
      fetchConversation: async (id: string) => {
        if (id === "c1") throw new ProviderShapeError("fake", "cannot represent this");
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

    assert.equal(report.sent, 2, "the other conversations must still be collected");
    assert.equal(report.failed, 1);
    assert.match(report.errors[0] ?? "", /c1: .*cannot represent/);
    assert.equal(report.watermark, "2026-11-15T13:30:00.000Z", "the run still makes progress");
  });

  it("stops on a request failure instead of hammering the provider", async () => {
    // A bad status is the provider saying stop. Stepping over it and walking
    // the remaining seven hundred would be the wrong lesson learned from the
    // fix above.
    stubFetch(ok);
    const adapter = fakeAdapter({
      fetchConversation: async () => {
        throw new ProviderRequestError("fake", "GET /x returned 429");
      },
    });

    const report = await syncProvider(adapter, SETTINGS, { sleep: noSleep });

    assert.equal(report.sent, 0);
    assert.equal(report.failed, 0, "a transport failure is not a bad record");
    assert.equal(report.errors.length, 1, "it stopped rather than trying all three");
  });

  it("stops once failures look systematic rather than unlucky", async () => {
    // Several in a row is a changed payload shape, not bad luck. Walking the
    // whole account to produce the same error hundreds of times buries the
    // first and only useful one.
    const many = Array.from({ length: 20 }, (_, i) => summary(`x${i}`, i + 1));
    stubFetch(ok);
    const adapter = fakeAdapter({
      listConversations: async () => many,
      fetchConversation: async () => {
        throw new ProviderShapeError("fake", "shape changed");
      },
    });

    const report = await syncProvider(adapter, SETTINGS, { maxConversations: 20, sleep: noSleep });

    assert.ok(report.failed < 20, `stopped early, not after all 20 (got ${report.failed})`);
    assert.match(report.errors.at(-1) ?? "", /systematic/);
  });

  it("caps the error list so one useful line is not buried", async () => {
    const many = Array.from({ length: 20 }, (_, i) => summary(`y${i}`, i + 1));
    stubFetch(ok);
    const adapter = fakeAdapter({
      listConversations: async () => many,
      fetchConversation: async () => {
        throw new ProviderShapeError("fake", "shape changed");
      },
    });

    const report = await syncProvider(adapter, SETTINGS, { maxConversations: 20, sleep: noSleep });

    assert.ok(report.errors.length <= 11, `got ${report.errors.length}`);
  });

  it("a run of failures does not reset the systematic check", async () => {
    // One success in the middle means the next failures are, again, one bad
    // record each — the counter has to start over.
    const many = Array.from({ length: 6 }, (_, i) => summary(`z${i}`, i + 1));
    stubFetch(ok);
    let call = 0;
    const adapter = fakeAdapter({
      listConversations: async () => many,
      fetchConversation: async (id: string) => {
        call += 1;
        if (call === 3) {
          return {
            id,
            title: id,
            transcript: "User: ok",
            startedAt: "2026-11-15T13:00:00.000Z",
            endedAt: "2026-11-15T13:00:00.000Z",
            messageCount: 1,
            model: null,
            url: "https://fake.test/ok",
          };
        }
        throw new ProviderShapeError("fake", "cannot represent");
      },
    });

    const report = await syncProvider(adapter, SETTINGS, { maxConversations: 6, sleep: noSleep });

    assert.equal(report.sent, 1);
    assert.equal(report.failed, 5, "six attempted, one stored, none cut short");
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

describe("empty conversations", () => {
  it("counts an unused chat instead of calling it an error", async () => {
    // Every provider creates a conversation record the moment a new chat is
    // opened. A first sync of a real account finds a dozen, and a dozen
    // error lines for a dozen non-problems is how an error list stops being
    // read — which matters, because that list is where the real failures go.
    stubFetch(ok);
    const adapter = fakeAdapter({
      fetchConversation: async (id: string) => {
        if (id === "c2") throw new ConversationEmpty("fake", id);
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

    assert.equal(report.empty, 1);
    assert.equal(report.sent, 2);
    assert.deepEqual(report.errors, [], "an unused chat is not a failure");
    assert.equal(report.failed, 0);
  });

  it("moves past an empty conversation for good", async () => {
    // There is nothing to collect, ever. Leaving the watermark behind it
    // would mean re-fetching it on every sync, forever.
    stubFetch(ok);
    const adapter = fakeAdapter({
      fetchConversation: async () => {
        throw new ConversationEmpty("fake", "x");
      },
    });

    const report = await syncProvider(adapter, SETTINGS, { sleep: noSleep });

    assert.equal(report.empty, 3);
    assert.equal(report.watermark, "2026-11-15T13:30:00.000Z");
  });

  it("does not let empties mask a systematic failure", async () => {
    // An empty neither counts as a failure nor clears the counter: five bad
    // payloads are still five bad payloads with unused chats in between.
    const many = Array.from({ length: 12 }, (_, i) => summary(`q${i}`, i + 1));
    stubFetch(ok);
    let n = 0;
    const adapter = fakeAdapter({
      listConversations: async () => many,
      fetchConversation: async (id: string) => {
        n += 1;
        throw n % 2 === 0
          ? new ConversationEmpty("fake", id)
          : new ProviderShapeError("fake", "shape changed");
      },
    });

    const report = await syncProvider(adapter, SETTINGS, { maxConversations: 12, sleep: noSleep });

    assert.match(report.errors.at(-1) ?? "", /systematic/);
  });
});
