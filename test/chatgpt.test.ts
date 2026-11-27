/**
 * The ChatGPT adapter, against the shapes a live account actually returned.
 *
 * The fixtures mirror a probe run: a 274-message conversation whose roles
 * were system 23, user 21, assistant 145, tool 85, with content types text,
 * multimodal_text, code, execution_output, thoughts, reasoning_recap and
 * model_editable_context. Most of what arrives is not conversation, and the
 * tests are mostly about what gets dropped.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildConversation,
  chatgpt,
  conversationUrl,
  isoFromEpoch,
  parseConversationList,
  parseMessages,
  requireWholeConversation,
  visibleText,
} from "../src/providers/chatgpt.js";
import { ProviderShapeError } from "../src/types.js";

const LIST = {
  items: [
    {
      id: "6a78e703-95c0-83ea-897c-5c48da1fd379",
      title: "Redesigning the ingest pipeline",
      create_time: "2026-09-07T19:07:30.327158Z",
      update_time: "2026-11-27T13:59:32.415302Z",
      is_archived: false,
      snippet: "…",
    },
  ],
  total: 21,
  limit: 20,
  offset: 0,
};

function msg(
  id: string,
  role: string,
  text: string,
  time: number,
  over: Record<string, unknown> = {},
) {
  return {
    id,
    author: { role },
    create_time: time,
    content: { content_type: "text", parts: [text] },
    status: "finished_successfully",
    weight: 1,
    metadata: {},
    recipient: "all",
    ...over,
  };
}

const DETAIL = {
  title: "Redesigning the ingest pipeline",
  default_model_slug: "gpt-5",
  current_node: "m4",
  page_info: {
    start_cursor: "dd916f38",
    end_cursor: "aa2246a4",
    has_previous_page: false,
    has_next_page: false,
  },
  context_truncation_continuation: null,
  messages: [
    msg("m1", "system", "you are helpful", 1_764_250_000, {
      metadata: { is_visually_hidden_from_conversation: true },
    }),
    msg("m2", "user", "how should we do this?", 1_764_250_050.5),
    msg("m3", "assistant", "Start with the schema.", 1_764_250_090.25),
    msg("m4", "tool", "{...}", 1_764_250_095, {
      content: { content_type: "execution_output", text: "ok" },
      recipient: "all",
    }),
  ],
};

const SUMMARY = {
  id: "6a78e703-95c0-83ea-897c-5c48da1fd379",
  title: "Redesigning the ingest pipeline",
  createdAt: "2026-09-07T19:07:30.327158Z",
  updatedAt: "2026-11-27T13:59:32.415302Z",
};

// ---------------------------------------------------------------------------
// Two timestamp formats in one provider
// ---------------------------------------------------------------------------

describe("isoFromEpoch", () => {
  it("passes an ISO string through, as the list sends", () => {
    assert.equal(isoFromEpoch("2026-11-27T13:59:32.415302Z"), "2026-11-27T13:59:32.415302Z");
  });

  it("converts the epoch seconds a message sends", () => {
    // Seconds, not milliseconds. Reading them as milliseconds would put
    // every conversation in 1970 — a wrong date that sorts and filters
    // without ever looking wrong.
    assert.equal(isoFromEpoch(1_764_250_050.5), "2025-11-27T13:27:30.500Z");
  });

  it("reports nothing for a value it cannot read", () => {
    assert.equal(isoFromEpoch(null), null);
    assert.equal(isoFromEpoch(undefined), null);
    assert.equal(isoFromEpoch(Number.NaN), null);
    assert.equal(isoFromEpoch(""), null);
  });
});

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

describe("parseConversationList", () => {
  it("reads id, title and both timestamps", () => {
    assert.deepEqual(parseConversationList(LIST), [SUMMARY]);
  });

  it("drops a row with no id", () => {
    const rows = parseConversationList({ items: [{ title: "x", create_time: "2026-01-01T00:00:00Z" }] });

    assert.deepEqual(rows, []);
  });

  it("drops an undated row rather than letting eMe file it by ingest time", () => {
    assert.deepEqual(parseConversationList({ items: [{ id: "x", title: "t" }] }), []);
  });

  it("raises on a shape it does not recognise, rather than reporting no chats", () => {
    assert.throws(() => parseConversationList({ conversations: [] }), ProviderShapeError);
    assert.throws(() => parseConversationList(null), ProviderShapeError);
  });
});

// ---------------------------------------------------------------------------
// What counts as a turn
// ---------------------------------------------------------------------------

describe("parseMessages", () => {
  it("keeps only what a person would recognise as the conversation", () => {
    const messages = parseMessages(DETAIL);

    assert.deepEqual(
      messages.map((m) => m.id),
      ["m2", "m3"],
    );
  });

  it("keeps the order the server gave, without inventing a tree", () => {
    // `messages` is flat: no parent, no children. The server has resolved
    // the branch, so reconstructing one would be undoing its work.
    const messages = parseMessages(DETAIL);

    assert.deepEqual(messages.map((m) => m.parentId), [null, null]);
  });

  it("converts message times to ISO", () => {
    assert.equal(parseMessages(DETAIL)[0]?.createdAt, "2025-11-27T13:27:30.500Z");
  });

  it("drops a system message", () => {
    const messages = parseMessages({ messages: [msg("s", "system", "sys", 1_764_250_000)] });

    assert.deepEqual(messages, []);
  });

  it("drops a tool message", () => {
    const messages = parseMessages({ messages: [msg("t", "tool", "out", 1_764_250_000)] });

    assert.deepEqual(messages, []);
  });

  it("drops a message the UI hides", () => {
    const messages = parseMessages({
      messages: [
        msg("h", "assistant", "memory written", 1_764_250_000, {
          metadata: { is_visually_hidden_from_conversation: true },
        }),
      ],
    });

    assert.deepEqual(messages, []);
  });

  it("drops a message addressed to a tool rather than to the person", () => {
    const messages = parseMessages({
      messages: [msg("p", "assistant", "run this", 1_764_250_000, { recipient: "python" })],
    });

    assert.deepEqual(messages, []);
  });

  it("raises on a shape it does not recognise", () => {
    assert.throws(() => parseMessages({ mapping: {} }), ProviderShapeError);
  });
});

// ---------------------------------------------------------------------------
// Content blocks — an allowlist, because new types keep appearing
// ---------------------------------------------------------------------------

describe("visibleText", () => {
  it("reads a text block's parts", () => {
    assert.equal(visibleText({ content_type: "text", parts: ["hello"] }), "hello");
  });

  it("keeps only the string parts of a multimodal block", () => {
    // The other parts describe images. Rendering one would put
    // "[object Object]" in the transcript.
    const text = visibleText({
      content_type: "multimodal_text",
      parts: [{ asset_pointer: "file-service://x" }, "what is in this picture?"],
    });

    assert.equal(text, "what is in this picture?");
  });

  it("drops model reasoning", () => {
    // Decided: it is not conversation, the user did not write it, and it
    // inflates every transcript. The cost is real — a search for something
    // the model reasoned about but never said will not find it.
    assert.equal(visibleText({ content_type: "thoughts", thoughts: ["hmm"] }), null);
    assert.equal(visibleText({ content_type: "reasoning_recap", content: "I considered" }), null);
  });

  it("drops the python tool and its output", () => {
    assert.equal(visibleText({ content_type: "code", language: "python", text: "x=1" }), null);
    assert.equal(visibleText({ content_type: "execution_output", text: "1" }), null);
  });

  it("drops custom instructions and memory", () => {
    // Settings, not anything that was said.
    assert.equal(
      visibleText({ content_type: "model_editable_context", model_set_context: "be terse" }),
      null,
    );
  });

  it("drops a disallowed type even when it is shaped like a readable one", () => {
    // The allowlist has to be what excludes these, not the absence of a
    // `parts` array. Written after a mutation test: adding "thoughts" and
    // "code" to the allowlist broke nothing, because every fixture for them
    // was being dropped by its shape instead. A test that passes for the
    // wrong reason guards nothing.
    assert.equal(visibleText({ content_type: "thoughts", parts: ["I considered X"] }), null);
    assert.equal(visibleText({ content_type: "code", parts: ["x = 1"] }), null);
    assert.equal(visibleText({ content_type: "execution_output", parts: ["1"] }), null);
    assert.equal(
      visibleText({ content_type: "model_editable_context", parts: ["be terse"] }),
      null,
    );
    assert.equal(visibleText({ content_type: "reasoning_recap", parts: ["in short"] }), null);
  });

  it("drops a type it has never seen", () => {
    // An allowlist on purpose: one probe found seven content types, and a
    // blocklist would quietly start letting new ones through.
    assert.equal(visibleText({ content_type: "some_future_thing", parts: ["x"] }), null);
  });

  it("drops an empty block", () => {
    assert.equal(visibleText({ content_type: "text", parts: ["   "] }), null);
    assert.equal(visibleText({ content_type: "text", parts: [] }), null);
    assert.equal(visibleText(null), null);
  });
});

// ---------------------------------------------------------------------------
// Refusing half a conversation
// ---------------------------------------------------------------------------

describe("requireWholeConversation", () => {
  it("accepts a conversation with nothing behind it", () => {
    assert.doesNotThrow(() => requireWholeConversation(DETAIL, "c1"));
  });

  it("refuses one with earlier messages behind a cursor", () => {
    // Half a transcript looks exactly like a whole one. Storing it would be
    // the silent failure; erroring puts it in the sync report instead.
    assert.throws(
      () => requireWholeConversation({ page_info: { has_previous_page: true } }, "c1"),
      ProviderShapeError,
    );
  });

  it("accepts a payload with no page_info at all", () => {
    assert.doesNotThrow(() => requireWholeConversation({ messages: [] }, "c1"));
  });
});

// ---------------------------------------------------------------------------
// The assembled record
// ---------------------------------------------------------------------------

describe("buildConversation", () => {
  const conversation = buildConversation(SUMMARY, DETAIL, SUMMARY.id);

  it("sends a readable transcript of the visible turns only", () => {
    assert.equal(
      conversation.transcript,
      "User: how should we do this?\n\nAssistant: Start with the schema.",
    );
  });

  it("sends none of the tool plumbing", () => {
    const sent = JSON.stringify(conversation);

    assert.ok(!sent.includes("execution_output"));
    assert.ok(!sent.includes("you are helpful"));
  });

  it("dates the conversation from its messages", () => {
    assert.equal(conversation.startedAt, "2025-11-27T13:27:30.500Z");
    assert.equal(conversation.endedAt, "2025-11-27T13:28:10.250Z");
  });

  it("counts the turns it kept, not the messages it received", () => {
    assert.equal(conversation.messageCount, 2);
  });

  it("reports the model the conversation ran on", () => {
    assert.equal(conversation.model, "gpt-5");
  });

  it("carries a link back", () => {
    assert.equal(conversation.url, `https://chatgpt.com/c/${SUMMARY.id}`);
    assert.equal(conversationUrl("abc"), "https://chatgpt.com/c/abc");
  });

  it("raises rather than storing a conversation with nothing visible in it", () => {
    // A thread of nothing but tool calls is not a conversation, and an empty
    // transcript in the index is worse than an error in the report.
    assert.throws(
      () => buildConversation(SUMMARY, { ...DETAIL, messages: [DETAIL.messages[0]] }, SUMMARY.id),
      ProviderShapeError,
    );
  });
});


// ---------------------------------------------------------------------------
// Walking a long conversation backwards
// ---------------------------------------------------------------------------
//
// The first request returns the NEWEST 50 messages. `?before=<start_cursor>`
// returns the ones before them — found by trying several parameter names
// against a conversation known to be paged.
//
// How the others failed is the part worth keeping. `cursor`, `start_cursor`
// and `after` all returned **200 with the same page and has_previous_page
// still true**. Any of them would have looked like working pagination and
// looped forever, re-fetching page one while believing it progressed. A 404
// would have been kinder.

function page(
  ids: string[],
  { hasPrevious = false, cursor = "c" }: { hasPrevious?: boolean; cursor?: string } = {},
) {
  return {
    title: "Long thread",
    default_model_slug: "gpt-5",
    page_info: { start_cursor: cursor, has_previous_page: hasPrevious },
    messages: ids.map((id, i) =>
      msg(id, i % 2 === 0 ? "user" : "assistant", `turn ${id}`, 1_764_250_000 + i),
    ),
  };
}

/** Serves /api/auth/session, then one response per subsequent request. */
function stubChatGpt(pages: unknown[]) {
  const urls: string[] = [];
  let next = 0;
  globalThis.fetch = (async (url: string | URL) => {
    const href = String(url);
    if (href.includes("/api/auth/session")) {
      return new Response(JSON.stringify({ accessToken: "tok" }), { status: 200 });
    }
    urls.push(href);
    const body = pages[next] ?? pages[pages.length - 1];
    next += 1;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return urls;
}

describe("fetchConversation paging", () => {
  it("fetches once when the conversation is whole", async () => {
    const urls = stubChatGpt([page(["a", "b"])]);

    const conversation = await chatgpt.fetchConversation("c1");

    assert.equal(conversation.messageCount, 2);
    assert.equal(urls.length, 1, "no cursor, no second request");
  });

  it("walks backwards and returns the whole conversation", async () => {
    // 50 newest, then 7 earlier — the real shape of the conversation that
    // exposed this: it reported 50 and was 57.
    const newest = Array.from({ length: 50 }, (_, i) => `n${i}`);
    const earlier = Array.from({ length: 7 }, (_, i) => `e${i}`);
    const urls = stubChatGpt([
      page(newest, { hasPrevious: true, cursor: "CUR" }),
      page(earlier),
    ]);

    const conversation = await chatgpt.fetchConversation("c1");

    assert.equal(conversation.messageCount, 57);
    assert.match(urls[1] ?? "", /\?before=CUR$/, "the parameter is `before`");
  });

  it("puts the earlier page first, so the transcript reads in order", async () => {
    const urls = stubChatGpt([
      page(["n0", "n1"], { hasPrevious: true }),
      page(["e0", "e1"]),
    ]);

    const conversation = await chatgpt.fetchConversation("c1");

    assert.ok(
      conversation.transcript.indexOf("turn e0") < conversation.transcript.indexOf("turn n0"),
      "earlier messages must come first",
    );
    assert.equal(urls.length, 2);
  });

  it("keeps walking while there is more", async () => {
    stubChatGpt([
      page(["a"], { hasPrevious: true, cursor: "c1" }),
      page(["b"], { hasPrevious: true, cursor: "c2" }),
      page(["c"]),
    ]);

    const conversation = await chatgpt.fetchConversation("x");

    assert.equal(conversation.messageCount, 3);
  });

  it("refuses to loop when a page returns nothing new", async () => {
    // The exact failure three other parameter names produce: 200, the same
    // messages, has_previous_page still true. Riding it spins forever while
    // looking like progress.
    stubChatGpt([
      page(["a", "b"], { hasPrevious: true }),
      page(["a", "b"], { hasPrevious: true }),
    ]);

    await assert.rejects(() => chatgpt.fetchConversation("x"), {
      name: "ProviderShapeError",
      message: /not advancing/,
    });
  });

  it("stops rather than paging without end", async () => {
    // Every page fresh and every page claiming more. A real conversation
    // does not do this; a changed payload shape might.
    let n = 0;
    globalThis.fetch = (async (url: string | URL) => {
      if (String(url).includes("/api/auth/session")) {
        return new Response(JSON.stringify({ accessToken: "tok" }), { status: 200 });
      }
      n += 1;
      return new Response(JSON.stringify(page([`m${n}`], { hasPrevious: true })), { status: 200 });
    }) as typeof fetch;

    await assert.rejects(() => chatgpt.fetchConversation("x"), { message: /still paging/ });
  });

  it("refuses when more is promised but no cursor is given", async () => {
    stubChatGpt([
      {
        ...page(["a"]),
        page_info: { has_previous_page: true, start_cursor: null },
      },
    ]);

    await assert.rejects(() => chatgpt.fetchConversation("x"), { message: /no cursor/ });
  });

  it("does not mistake an all-tool page for a stalled one", async () => {
    // Freshness is judged on RAW ids, not on parsed messages. A page can
    // legitimately hold nothing but system and tool messages, and treating
    // that as "no progress" would abort a conversation paging correctly.
    const toolOnly = {
      ...page([]),
      page_info: { start_cursor: "c2", has_previous_page: true },
      messages: [msg("t1", "tool", "{}", 1_764_249_000)],
    };
    stubChatGpt([page(["n0"], { hasPrevious: true }), toolOnly, page(["e0"])]);

    const conversation = await chatgpt.fetchConversation("x");

    assert.equal(conversation.messageCount, 2, "the tool page advanced without being counted");
  });
});


// ---------------------------------------------------------------------------
// Listing: two queries, unioned
// ---------------------------------------------------------------------------
//
// A probe found the default list and `is_archived=false` returning the same
// 761 conversations — on an account with ZERO archived ones, which cannot
// say whether the default includes them. The tester may file things away,
// and a quietly partial history is the failure this project keeps paying
// for, so both are asked for and unioned.

function listPage(ids: string[], over: Record<string, unknown> = {}) {
  return {
    items: ids.map((id, i) => ({
      id,
      title: `t${id}`,
      create_time: "2026-01-01T00:00:00Z",
      update_time: `2026-01-0${(i % 9) + 1}T00:00:00Z`,
      ...over,
    })),
  };
}

/** Serves the session, then a body per request, recording the URLs asked for. */
function stubList(bodies: unknown[]) {
  const urls: string[] = [];
  let next = 0;
  globalThis.fetch = (async (url: string | URL) => {
    const href = String(url);
    if (href.includes("/api/auth/session")) {
      return new Response(JSON.stringify({ accessToken: "tok" }), { status: 200 });
    }
    urls.push(href);
    const body = bodies[next] ?? { items: [] };
    next += 1;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return urls;
}

describe("listConversations", () => {
  it("asks for the archived conversations too", async () => {
    const urls = stubList([listPage(["a"]), listPage([])]);

    await chatgpt.listConversations();

    assert.equal(urls.length, 2);
    assert.ok(!urls[0]!.includes("is_archived"), "the default listing first");
    assert.ok(urls[1]!.includes("is_archived=true"), "then the archived one");
  });

  it("includes an archived conversation the default list omitted", async () => {
    const urls = stubList([listPage(["a"]), listPage(["z"])]);

    const all = await chatgpt.listConversations();

    assert.deepEqual(all.map((c) => c.id).sort(), ["a", "z"]);
    assert.equal(urls.length, 2);
  });

  it("does not return a conversation twice when both listings have it", async () => {
    stubList([listPage(["a", "b"]), listPage(["b"])]);

    const all = await chatgpt.listConversations();

    assert.deepEqual(all.map((c) => c.id).sort(), ["a", "b"]);
  });

  it("stops paging once a page ends past the watermark", async () => {
    // 100 rows means "there may be more"; the watermark is what says there
    // is nothing older worth asking for.
    const full = listPage(Array.from({ length: 100 }, (_, i) => `c${i}`));
    const urls = stubList([full, listPage([])]);

    await chatgpt.listConversations("2026-12-31T00:00:00Z");

    assert.equal(urls.length, 2, "one page of each listing, not more");
  });

  it("keeps paging while a full page is still newer than the watermark", async () => {
    const full = listPage(Array.from({ length: 100 }, (_, i) => `c${i}`));
    const urls = stubList([full, listPage(["tail"]), listPage([])]);

    await chatgpt.listConversations("2020-01-01T00:00:00Z");

    assert.ok(urls.length >= 3, `kept going: ${urls.length} request(s)`);
    assert.ok(urls[1]!.includes("offset=100"), "the second page of the default listing");
  });
});
