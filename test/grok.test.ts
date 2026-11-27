/**
 * The Grok adapter, against the shapes a real account actually returned.
 *
 * The fixtures below are trimmed from captured payloads. The trimming is the
 * point: what is omitted here is what the extractor must drop, and the
 * `webSearchResults` fixture is a miniature of the real one, where a two-turn
 * exchange arrived carrying forty scraped third-party pages four times over.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildConversation,
  conversationUrl,
  parseConversationList,
  parseModel,
  parseResponses,
} from "../src/providers/grok.js";
import { ConversationNotSettled, ProviderShapeError } from "../src/types.js";

const LIST = {
  conversations: [
    {
      conversationId: "ba8b8db1-9c1b-4a53-a4b6-2ba630f20cf0",
      title: "Export full chat history request",
      createTime: "2026-11-15T13:30:51.493Z",
      modifyTime: "2026-11-15T13:31:00.286Z",
      starred: false,
      temporary: false,
    },
  ],
  textSearchMatches: [],
};

const RESPONSES = {
  responses: [
    {
      responseId: "a5ede69f-6c5b-473c-b4cb-f20c81fc4daf",
      message: "jaberwocky in spanish",
      sender: "human",
      createTime: "2026-11-15T13:33:53.668Z",
      parentResponseId: "73c0afc7-ff7b-521e-97f4-739bba05c287",
      webSearchResults: [],
      steps: [],
    },
    {
      responseId: "a8debeb8-e5ab-44ce-a6f5-7f240a60c2fb",
      message: "**Jabberwocky** is Lewis Carroll's nonsense poem.",
      sender: "assistant",
      createTime: "2026-11-15T13:34:10.221Z",
      parentResponseId: "a5ede69f-6c5b-473c-b4cb-f20c81fc4daf",
      model: "grok-4",
      webSearchResults: [
        { url: "https://lyricstranslate.com/en/lewis-carroll-jabberwocky", preview: "# Lewis…" },
      ],
      steps: [{ toolUsageResults: [{ webSearchResults: [{ url: "https://example.com" }] }] }],
      ragResults: [],
      xposts: [],
    },
  ],
  inflightResponses: [],
};

const SUMMARY = {
  id: "ba8b8db1-9c1b-4a53-a4b6-2ba630f20cf0",
  title: "Export full chat history request",
  createdAt: "2026-11-15T13:30:51.493Z",
  updatedAt: "2026-11-15T13:31:00.286Z",
};

describe("parseConversationList", () => {
  it("reads id, title and both timestamps", () => {
    const [row] = parseConversationList(LIST);

    assert.deepEqual(row, SUMMARY);
  });

  it("treats a conversation that was never edited as unchanged since creation", () => {
    const [row] = parseConversationList({
      conversations: [{ conversationId: "x", title: "t", createTime: "2026-01-01T00:00:00Z" }],
    });

    assert.equal(row?.updatedAt, "2026-01-01T00:00:00Z");
  });

  it("drops a row with no id, which cannot be upserted", () => {
    const rows = parseConversationList({
      conversations: [{ title: "orphan", createTime: "2026-01-01T00:00:00Z" }],
    });

    assert.deepEqual(rows, []);
  });

  it("drops an undated row rather than letting it be filed by ingest time", () => {
    const rows = parseConversationList({ conversations: [{ conversationId: "x", title: "t" }] });

    assert.deepEqual(rows, []);
  });

  it("names a conversation Grok left untitled", () => {
    const [row] = parseConversationList({
      conversations: [{ conversationId: "x", createTime: "2026-01-01T00:00:00Z" }],
    });

    assert.equal(row?.title, "Untitled");
  });

  it("raises on a shape it does not recognise, rather than reporting no chats", () => {
    assert.throws(() => parseConversationList({ items: [] }), ProviderShapeError);
    assert.throws(() => parseConversationList(null), ProviderShapeError);
  });
});

describe("parseResponses", () => {
  it("keeps only the speaker, the text, the time and the parent pointer", () => {
    const messages = parseResponses(RESPONSES);

    assert.deepEqual(messages[0], {
      id: "a5ede69f-6c5b-473c-b4cb-f20c81fc4daf",
      parentId: "73c0afc7-ff7b-521e-97f4-739bba05c287",
      role: "user",
      text: "jaberwocky in spanish",
      createdAt: "2026-11-15T13:33:53.668Z",
    });
    assert.deepEqual(Object.keys(messages[1] ?? {}).sort(), [
      "createdAt",
      "id",
      "parentId",
      "role",
      "text",
    ]);
  });

  it("maps Grok's `human` onto the user role", () => {
    assert.equal(parseResponses(RESPONSES)[0]?.role, "user");
  });

  it("skips a turn whose sender it does not understand", () => {
    // Attributing someone's words to the wrong speaker is worse than losing
    // the turn, and Grok adds sender kinds over time.
    const messages = parseResponses({
      responses: [
        { responseId: "x", message: "?", sender: "system", createTime: "2026-01-01T00:00:00Z" },
      ],
    });

    assert.deepEqual(messages, []);
  });

  it("raises on a shape it does not recognise", () => {
    assert.throws(() => parseResponses({ turns: [] }), ProviderShapeError);
  });
});

describe("parseModel", () => {
  it("reports the model from the last turn that named one", () => {
    assert.equal(parseModel(RESPONSES), "grok-4");
  });

  it("reports null when no turn named one", () => {
    assert.equal(parseModel({ responses: [{ responseId: "x" }] }), null);
  });
});

describe("buildConversation", () => {
  const conversation = buildConversation(SUMMARY, RESPONSES);

  it("sends a readable transcript, not the provider's JSON", () => {
    assert.equal(
      conversation.transcript,
      "User: jaberwocky in spanish\n\n" +
        "Assistant: **Jabberwocky** is Lewis Carroll's nonsense poem.",
    );
  });

  it("sends none of the scraped third-party pages", () => {
    // The single most important thing this collector does. Those previews
    // are other people's web pages; embedding them would pollute the user's
    // own search results with material that is not theirs.
    assert.ok(!conversation.transcript.includes("lyricstranslate"));
    assert.ok(!JSON.stringify(conversation).includes("lyricstranslate"));
    assert.ok(!JSON.stringify(conversation).includes("toolUsageResults"));
  });

  it("dates the conversation from the messages, not from the list row", () => {
    // The list's createTime is when the record was made; these are when the
    // user actually spoke. An undated record reports no date at all.
    assert.equal(conversation.startedAt, "2026-11-15T13:33:53.668Z");
    assert.equal(conversation.endedAt, "2026-11-15T13:34:10.221Z");
  });

  it("counts the turns it kept", () => {
    assert.equal(conversation.messageCount, 2);
  });

  it("carries a link back to the conversation", () => {
    assert.equal(
      conversation.url,
      "https://grok.com/chat/ba8b8db1-9c1b-4a53-a4b6-2ba630f20cf0",
    );
    assert.equal(conversationUrl("abc"), "https://grok.com/chat/abc");
  });

  it("keys the upsert on Grok's own conversation id", () => {
    assert.equal(conversation.id, SUMMARY.id);
  });

  it("refuses a conversation Grok is still generating", () => {
    // Storing it now would persist half an answer, and the watermark would
    // move past it and never come back for the rest.
    assert.throws(
      () => buildConversation(SUMMARY, { ...RESPONSES, inflightResponses: [{ responseId: "x" }] }),
      ConversationNotSettled,
    );
  });

  it("treats an empty inflight list as settled", () => {
    // The normal case: every captured payload carries the key, empty.
    assert.equal(buildConversation(SUMMARY, RESPONSES).messageCount, 2);
  });

  it("treats a payload with no inflight key as settled", () => {
    const { responses } = RESPONSES;

    assert.equal(buildConversation(SUMMARY, { responses }).messageCount, 2);
  });

  it("raises rather than storing an empty conversation", () => {
    assert.throws(
      () => buildConversation(SUMMARY, { responses: [] }),
      ProviderShapeError,
    );
  });
});
