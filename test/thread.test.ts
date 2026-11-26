/**
 * The tree walk, which is the one piece of logic every provider shares.
 *
 * Getting this wrong does not throw. It produces a transcript that reads
 * perfectly and interleaves branches the user abandoned — which is why it is
 * tested harder than anything else here.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { activePath, renderTranscript } from "../src/thread.js";
import type { Message } from "../src/types.js";

function msg(id: string, parentId: string | null, text: string, minute: number): Message {
  return {
    id,
    parentId,
    role: id.startsWith("u") ? "user" : "assistant",
    text,
    createdAt: `2026-11-15T13:${String(minute).padStart(2, "0")}:00.000Z`,
  };
}

describe("activePath", () => {
  it("returns a straight thread in order", () => {
    const messages = [msg("u1", null, "hi", 1), msg("a1", "u1", "hello", 2)];

    assert.deepEqual(
      activePath(messages, "a1").map((m) => m.id),
      ["u1", "a1"],
    );
  });

  it("orders by the parent pointer, not by the order the provider sent", () => {
    // Providers do not promise an order, and Grok's `responses[]` is just an
    // array. Trusting its order would be trusting an undocumented detail.
    const messages = [msg("a1", "u1", "hello", 2), msg("u1", null, "hi", 1)];

    assert.deepEqual(
      activePath(messages, "a1").map((m) => m.id),
      ["u1", "a1"],
    );
  });

  it("excludes the branch the user abandoned", () => {
    // u1 → a1, then the user edited u1 into u2, which was answered by a2.
    // a1 is still in the payload and is not part of the conversation.
    const messages = [
      msg("u1", null, "first question", 1),
      msg("a1", "u1", "answer to the question that was replaced", 2),
      msg("u2", "u1", "edited question", 3),
      msg("a2", "u2", "answer the user kept", 4),
    ];

    const path = activePath(messages, "a2");

    assert.deepEqual(
      path.map((m) => m.id),
      ["u1", "u2", "a2"],
    );
    assert.ok(
      !renderTranscript(path).includes("replaced"),
      "an abandoned branch must not reach the transcript",
    );
  });

  it("falls back to the newest message when no leaf is named", () => {
    // Grok names no current leaf. A conversation we can read is worth more
    // than one we discard for want of a pointer.
    const messages = [msg("u1", null, "hi", 1), msg("a1", "u1", "hello", 2)];

    assert.deepEqual(
      activePath(messages, null).map((m) => m.id),
      ["u1", "a1"],
    );
  });

  it("falls back when the named leaf is not in the payload", () => {
    const messages = [msg("u1", null, "hi", 1), msg("a1", "u1", "hello", 2)];

    assert.deepEqual(
      activePath(messages, "a-missing").map((m) => m.id),
      ["u1", "a1"],
    );
  });

  it("stops rather than hangs on a parent cycle", () => {
    // A hang in a service worker is the one failure a user cannot diagnose.
    const messages = [msg("u1", "a1", "hi", 1), msg("a1", "u1", "hello", 2)];

    const path = activePath(messages, "a1");

    assert.equal(path.length, 2);
  });

  it("returns nothing for an empty conversation", () => {
    assert.deepEqual(activePath([], null), []);
  });

  it("stops at a parent that is missing, keeping what it has", () => {
    // A truncated fetch should yield the tail of the thread, not an error.
    const messages = [msg("a2", "u2", "answer", 4), msg("u2", "u-not-here", "question", 3)];

    assert.deepEqual(
      activePath(messages, "a2").map((m) => m.id),
      ["u2", "a2"],
    );
  });
});

describe("renderTranscript", () => {
  it("prefixes each turn with its speaker", () => {
    const messages = [msg("u1", null, "hi", 1), msg("a1", "u1", "hello", 2)];

    assert.equal(renderTranscript(messages), "User: hi\n\nAssistant: hello");
  });

  it("is empty for no messages", () => {
    assert.equal(renderTranscript([]), "");
  });
});
