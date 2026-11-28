/**
 * Claude.ai.
 *
 * The provider the shared leaf-to-root walk was actually written for. Grok
 * needed it but roots its threads with a synthetic parent; ChatGPT turned
 * out not to need it at all, since its server resolves the branch. Claude
 * gives both halves honestly: every message carries `parent_message_uuid`,
 * and the conversation names `current_leaf_message_uuid`.
 *
 * Confirmed by probe, and three of these contradict the notes this was
 * going to be written from:
 *
 *   - A message's flat `text` is EMPTY. The content lives in `content[]`,
 *     typed. Building on `text`, as the notes describe, would have collected
 *     conversations containing nothing — and an empty transcript is not an
 *     error anywhere downstream, it is just a record that never matches.
 *   - There are TWO organizations on an ordinary account: one with
 *     capabilities ["claude_pro","chat"], one API-only. Taking the first
 *     happens to work and is luck.
 *   - `?tree=True` changes nothing, so it is not sent.
 *
 *   - Timestamps are ISO 8601 strings throughout, so no conversion.
 *   - `limit`/`offset` page correctly, with no overlap.
 *   - Senders are `human` and `assistant`; content blocks seen are `text`
 *     and `thinking`.
 */

import { ProviderRequestError, ProviderShapeError } from "../types.js";
import type { Conversation, ConversationSummary, Message, ProviderAdapter } from "../types.js";
import { activePath, renderTranscript } from "../thread.js";

const ORIGIN = "https://claude.ai";
const PAGE_SIZE = 100;
const MAX_PAGES = 50;

/**
 * Content blocks whose text is part of the conversation.
 *
 * An allowlist, as for ChatGPT. `thinking` is dropped for the reason it is
 * dropped everywhere: it is model reasoning, the user did not write it, and
 * it inflates every transcript. `tool_use`, `tool_result` and `image` are
 * not text a person wrote or read as dialogue.
 */
const VISIBLE_BLOCK_TYPES = new Set(["text"]);

export function conversationUrl(id: string): string {
  return `${ORIGIN}/chat/${id}`;
}

/**
 * The organization that holds chats.
 *
 * By capability, not by position. An ordinary account has two: one for
 * claude.ai with "chat", one API-only. The chat one happened to come first
 * on the account this was built against, which is exactly the kind of
 * accident that works until it does not.
 */
export function pickChatOrg(payload: unknown): string {
  const orgs = Array.isArray(payload) ? payload : (payload as { items?: unknown[] })?.items;
  if (!Array.isArray(orgs) || orgs.length === 0) {
    throw new ProviderShapeError("claude", "no organizations returned — probably signed out");
  }

  const withChat = (orgs as Record<string, unknown>[]).find((o) => {
    const caps = o?.capabilities;
    return Array.isArray(caps) && caps.includes("chat");
  });
  const chosen = withChat ?? null;
  if (chosen === null) {
    throw new ProviderShapeError(
      "claude",
      `none of the ${orgs.length} organization(s) has the "chat" capability`,
    );
  }
  const uuid = chosen.uuid ?? chosen.id;
  if (typeof uuid !== "string" || uuid === "") {
    throw new ProviderShapeError("claude", "the chat organization has no uuid");
  }
  return uuid;
}

/** List rows → summaries. The list is a bare array, not an envelope. */
export function parseConversationList(payload: unknown): ConversationSummary[] {
  const rows = Array.isArray(payload) ? payload : (payload as { items?: unknown })?.items;
  if (!Array.isArray(rows)) {
    throw new ProviderShapeError("claude", "conversation list is not an array");
  }

  const summaries: ConversationSummary[] = [];
  for (const row of rows as Record<string, unknown>[]) {
    const id = typeof row?.uuid === "string" ? row.uuid : null;
    const created = typeof row?.created_at === "string" ? row.created_at : null;
    const updated = typeof row?.updated_at === "string" ? row.updated_at : null;
    if (id === null || created === null) continue;
    summaries.push({
      id,
      // `name` rather than `title`, and empty for an unnamed chat.
      title: typeof row?.name === "string" && row.name ? row.name : "Untitled",
      createdAt: created,
      updatedAt: updated ?? created,
    });
  }
  return summaries;
}

/** The visible text of one message, from its typed blocks. */
export function visibleText(message: unknown): string | null {
  const blocks = (message as { content?: unknown } | null)?.content;
  if (!Array.isArray(blocks)) return null;

  const text = blocks
    .filter((block): block is { type: string; text: string } => {
      const b = block as { type?: unknown; text?: unknown } | null;
      return (
        typeof b?.type === "string" && VISIBLE_BLOCK_TYPES.has(b.type) && typeof b.text === "string"
      );
    })
    .map((block) => block.text)
    .join("\n")
    .trim();
  return text === "" ? null : text;
}

/**
 * `chat_messages` → messages, keeping the tree pointers.
 *
 * Note what is NOT read: the flat `text` field. It came back empty on every
 * message probed while the text blocks held the content, so the two
 * disagree and only one of them is right.
 */
export function parseMessages(payload: unknown): Message[] {
  const rows = (payload as { chat_messages?: unknown } | null)?.chat_messages;
  if (!Array.isArray(rows)) {
    throw new ProviderShapeError("claude", "conversation has no `chat_messages` array");
  }

  const messages: Message[] = [];
  for (const row of rows as Record<string, unknown>[]) {
    const id = typeof row?.uuid === "string" ? row.uuid : null;
    const createdAt = typeof row?.created_at === "string" ? row.created_at : null;
    const sender = row?.sender;
    if (id === null || createdAt === null) continue;
    if (sender !== "human" && sender !== "assistant") continue;

    const text = visibleText(row);
    if (text === null) continue;

    messages.push({
      id,
      parentId: typeof row?.parent_message_uuid === "string" ? row.parent_message_uuid : null,
      role: sender === "human" ? "user" : "assistant",
      text,
      createdAt,
    });
  }
  return messages;
}

/** Everything above, assembled into the record eMe stores. */
export function buildConversation(summary: ConversationSummary, payload: unknown): Conversation {
  const detail = payload as { name?: unknown; model?: unknown; current_leaf_message_uuid?: unknown };
  const leaf =
    typeof detail?.current_leaf_message_uuid === "string"
      ? detail.current_leaf_message_uuid
      : null;

  // The leaf is named and present, so this is a real branch resolution
  // rather than the reconstruction Grok needs.
  const path = activePath(parseMessages(payload), leaf);
  if (path.length === 0) {
    throw new ProviderShapeError("claude", `conversation ${summary.id} yielded no messages`);
  }

  const first = path[0]!;
  const last = path[path.length - 1]!;
  return {
    id: summary.id,
    title: typeof detail?.name === "string" && detail.name ? detail.name : summary.title,
    transcript: renderTranscript(path),
    startedAt: first.createdAt,
    endedAt: last.createdAt,
    messageCount: path.length,
    model: typeof detail?.model === "string" && detail.model ? detail.model : null,
    url: conversationUrl(summary.id),
  };
}

export const claude: ProviderAdapter = {
  source: "claude",
  origin: ORIGIN,

  async listConversations(since?: string): Promise<ConversationSummary[]> {
    const org = pickChatOrg(await getJson("/api/organizations"));
    const all: ConversationSummary[] = [];

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const body = await getJson(
        `/api/organizations/${org}/chat_conversations` +
          `?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`,
      );
      const batch = parseConversationList(body);
      all.push(...batch);

      if (batch.length < PAGE_SIZE) break;
      // Claude's list is newest-first, so a page ending at or behind the
      // watermark means there is nothing older worth asking for.
      if (since !== undefined && batch[batch.length - 1]!.updatedAt <= since) break;
    }
    return all;
  },

  async fetchConversation(id: string): Promise<Conversation> {
    const org = pickChatOrg(await getJson("/api/organizations"));
    // No `tree=True`: it was probed with and without and changed nothing,
    // and a parameter carried for superstition is a parameter nobody dares
    // remove later.
    const payload = await getJson(`/api/organizations/${org}/chat_conversations/${id}`);
    const summary: ConversationSummary = { id, title: "Untitled", createdAt: "", updatedAt: "" };
    return buildConversation(summary, payload);
  },
};

async function getJson(path: string): Promise<unknown> {
  const response = await fetch(`${ORIGIN}${path}`, {
    // Cookie auth, as with Grok: the user's own session, which is the
    // premise of the whole extension.
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new ProviderRequestError("claude", `GET ${path} returned ${response.status}`);
  }
  return response.json();
}
