/**
 * The Claude adapter, against the shapes a live account returned.
 *
 * Three of these tests exist because the probe contradicted the notes this
 * adapter was going to be written from. The flat `text` field is empty, the
 * content is in typed blocks, and there are two organizations of which only
 * one holds chats.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildConversation,
  claude,
  conversationUrl,
  parseConversationList,
  parseMessages,
  pickChatOrg,
  visibleText,
} from "../src/providers/claude.js";
import { ProviderShapeError } from "../src/types.js";

const ORGS = [
  { uuid: "4e8fafd5-1468-45f5-ab81-3451f9a30e01", capabilities: ["claude_pro", "chat"] },
  { uuid: "732daab7-0000-0000-0000-000000000000", capabilities: ["api", "api_individual"] },
];

const LIST = [
  {
    uuid: "c-1",
    name: "Redesigning the ingest pipeline",
    created_at: "2026-11-25T13:44:40.209876Z",
    updated_at: "2026-11-25T13:47:55.013495Z",
    is_archived: false,
    is_starred: false,
    project: null,
    current_leaf_message_uuid: "m3",
  },
];

function message(uuid: string, sender: string, text: string, parent: string | null, min: number) {
  return {
    uuid,
    // Empty on purpose: the live API sends it empty and puts the content in
    // the blocks. A test fixture that filled it in would hide the bug this
    // adapter exists to avoid.
    text: "",
    content: [{ type: "text", text, citations: [] }],
    sender,
    index: min,
    created_at: `2026-11-25T13:4${min}:00.000000Z`,
    parent_message_uuid: parent,
    truncated: false,
  };
}

const DETAIL = {
  uuid: "c-1",
  name: "Redesigning the ingest pipeline",
  model: "claude-opus-5",
  current_leaf_message_uuid: "m3",
  chat_messages: [
    message("m1", "human", "how should we do this?", "00000000-0000-4000-8000-000000000000", 4),
    message("m2", "assistant", "Start with the schema.", "m1", 5),
    message("m3", "human", "and the dates?", "m2", 6),
  ],
};

const SUMMARY = {
  id: "c-1",
  title: "Redesigning the ingest pipeline",
  createdAt: "2026-11-25T13:44:40.209876Z",
  updatedAt: "2026-11-25T13:47:55.013495Z",
};

// ---------------------------------------------------------------------------
// Which organization
// ---------------------------------------------------------------------------

describe("pickChatOrg", () => {
  it("chooses by capability, not by position", () => {
    // An ordinary account has two: one for claude.ai, one API-only. The
    // chat one came first on the account this was built against, which is
    // the kind of accident that works until it does not.
    assert.equal(pickChatOrg(ORGS), ORGS[0]!.uuid);
  });

  it("still finds it when the API organization is listed first", () => {
    assert.equal(pickChatOrg([ORGS[1], ORGS[0]]), ORGS[0]!.uuid);
  });

  it("raises rather than guessing when none can hold chats", () => {
    assert.throws(() => pickChatOrg([ORGS[1]]), ProviderShapeError);
  });

  it("raises when signed out", () => {
    assert.throws(() => pickChatOrg([]), ProviderShapeError);
    assert.throws(() => pickChatOrg(null), ProviderShapeError);
  });
});

// ---------------------------------------------------------------------------
// The list, which is a bare array
// ---------------------------------------------------------------------------

describe("parseConversationList", () => {
  it("reads a bare array, not an envelope", () => {
    assert.deepEqual(parseConversationList(LIST), [SUMMARY]);
  });

  it("names an unnamed conversation", () => {
    const [row] = parseConversationList([{ ...LIST[0], name: "" }]);

    assert.equal(row?.title, "Untitled");
  });

  it("drops a row with no id or no date", () => {
    assert.deepEqual(parseConversationList([{ name: "x", created_at: "2026-01-01T00:00:00Z" }]), []);
    assert.deepEqual(parseConversationList([{ uuid: "x", name: "y" }]), []);
  });

  it("raises on a shape it does not recognise", () => {
    assert.throws(() => parseConversationList({ conversations: [] }), ProviderShapeError);
  });
});

// ---------------------------------------------------------------------------
// Where the text actually is
// ---------------------------------------------------------------------------

describe("visibleText", () => {
  it("reads the typed blocks, not the flat field", () => {
    // The live API returns `text: ""` with the content in blocks. The notes
    // said to read `text`; doing so would have collected conversations
    // containing nothing — and an empty transcript is not an error anywhere
    // downstream, just a record that never matches a search.
    const text = visibleText({
      text: "",
      content: [{ type: "text", text: "the real content" }],
    });

    assert.equal(text, "the real content");
  });

  it("joins several text blocks", () => {
    const text = visibleText({
      content: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
    });

    assert.equal(text, "first\nsecond");
  });

  it("drops thinking blocks", () => {
    const text = visibleText({
      content: [
        { type: "thinking", thinking: "let me consider" },
        { type: "text", text: "the answer" },
      ],
    });

    assert.equal(text, "the answer");
  });

  it("drops a block type it has never seen", () => {
    // An allowlist, as for ChatGPT: providers add types, and a blocklist
    // would quietly start letting new ones through.
    assert.equal(visibleText({ content: [{ type: "tool_use", input: {} }] }), null);
    assert.equal(visibleText({ content: [{ type: "image", source: {} }] }), null);
    assert.equal(visibleText({ content: [{ type: "future_thing", text: "x" }] }), null);
  });

  it("reports nothing for a message with no blocks", () => {
    assert.equal(visibleText({ content: [] }), null);
    assert.equal(visibleText({ text: "ignored" }), null);
  });
});

// ---------------------------------------------------------------------------
// Messages and the tree
// ---------------------------------------------------------------------------

describe("parseMessages", () => {
  it("keeps the parent pointers, which is what the walk needs", () => {
    const messages = parseMessages(DETAIL);

    assert.deepEqual(
      messages.map((m) => m.parentId),
      ["00000000-0000-4000-8000-000000000000", "m1", "m2"],
    );
  });

  it("maps human onto the user role", () => {
    assert.equal(parseMessages(DETAIL)[0]?.role, "user");
  });

  it("skips a sender it does not understand", () => {
    const messages = parseMessages({
      chat_messages: [message("x", "system", "sys", null, 1)],
    });

    assert.deepEqual(messages, []);
  });

  it("raises on a shape it does not recognise", () => {
    assert.throws(() => parseMessages({ messages: [] }), ProviderShapeError);
  });
});

describe("buildConversation", () => {
  const conversation = buildConversation(SUMMARY, DETAIL);

  it("walks the named leaf back to the root", () => {
    assert.equal(
      conversation.transcript,
      "User: how should we do this?\n\n" +
        "Assistant: Start with the schema.\n\n" +
        "User: and the dates?",
    );
  });

  it("follows the leaf rather than the array order", () => {
    // Claude is the provider the shared walk was written for: it names a
    // leaf AND carries parent pointers. Grok reconstructs from the newest
    // message; ChatGPT needs no walk at all.
    const branched = {
      ...DETAIL,
      current_leaf_message_uuid: "m2",
      chat_messages: [
        ...DETAIL.chat_messages,
        message("m4", "assistant", "an abandoned answer", "m1", 7),
      ],
    };

    const built = buildConversation(SUMMARY, branched);

    assert.ok(!built.transcript.includes("abandoned"));
    assert.equal(built.messageCount, 2);
  });

  it("dates the conversation from its messages", () => {
    assert.equal(conversation.startedAt, "2026-11-25T13:44:00.000000Z");
    assert.equal(conversation.endedAt, "2026-11-25T13:46:00.000000Z");
  });

  it("reports the model", () => {
    assert.equal(conversation.model, "claude-opus-5");
  });

  it("carries a link back", () => {
    assert.equal(conversation.url, "https://claude.ai/chat/c-1");
    assert.equal(conversationUrl("abc"), "https://claude.ai/chat/abc");
  });

  it("raises rather than storing an empty conversation", () => {
    assert.throws(
      () => buildConversation(SUMMARY, { ...DETAIL, chat_messages: [] }),
      ProviderShapeError,
    );
  });
});


// ---------------------------------------------------------------------------
// The rendering mode, which decides whether anything is collected at all
// ---------------------------------------------------------------------------
//
// WITHOUT `rendering_mode=messages` the response carries a flat `text` per
// message and no `content` array. WITH it, `text` is empty and the content
// is in typed blocks. Two probes disagreed about which was true, because one
// sent the parameter and the other did not — and this adapter, reading only
// the blocks, would have parsed every conversation to zero messages.
//
// That failure is quiet: zero visible messages is not an error anywhere
// downstream. It is a provider that syncs, reports success, and stores
// conversations with nothing in them.

function flatMessage(uuid: string, sender: string, text: string, parent: string | null) {
  return {
    uuid,
    text, // populated, and no `content` at all — the un-rendered shape
    sender,
    created_at: "2026-11-25T13:44:00.000000Z",
    parent_message_uuid: parent,
  };
}

describe("rendering mode", () => {
  it("requests the typed blocks", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL) => {
      urls.push(String(url));
      const body = String(url).includes("/organizations/") && String(url).includes("chat_conversations")
        ? DETAIL
        : ORGS;
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;

    await claude.fetchConversation("c-1");

    const detailUrl = urls.find((u) => u.includes("chat_conversations/"));
    assert.match(detailUrl ?? "", /rendering_mode=messages/);
    assert.ok(!detailUrl?.includes("tree=True"), "tree=True changed nothing, so it is not sent");
  });

  it("says so when the response came back un-rendered", () => {
    // Rather than "yielded no messages", which would send the next person
    // looking at the parser instead of at the request.
    const unrendered = {
      ...DETAIL,
      chat_messages: [
        flatMessage("m1", "human", "how should we do this?", null),
        flatMessage("m2", "assistant", "Start with the schema.", "m1"),
      ],
    };

    assert.throws(() => buildConversation(SUMMARY, unrendered), {
      name: "ProviderShapeError",
      message: /rendering_mode=messages/,
    });
  });

  it("still reports an empty conversation as empty", () => {
    // No messages at all is a different thing from messages we cannot read,
    // and conflating them would make the rendering-mode hint misleading.
    assert.throws(() => buildConversation(SUMMARY, { ...DETAIL, chat_messages: [] }), {
      message: /yielded no messages/,
    });
  });
});

// ---------------------------------------------------------------------------
// The synthetic root
// ---------------------------------------------------------------------------

describe("the root message's parent", () => {
  it("walks the whole thread despite a parent that is not in the set", () => {
    // Claude roots a thread at 00000000-0000-4000-8000-000000000000, which
    // the API never returns — exactly as Grok does. A dangling parent reads
    // like evidence of unfetched turns and here means nothing of the sort.
    const conversation = buildConversation(SUMMARY, DETAIL);

    assert.equal(conversation.messageCount, 3);
    assert.ok(conversation.transcript.startsWith("User: how should we do this?"));
  });
});
