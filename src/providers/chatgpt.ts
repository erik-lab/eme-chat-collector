/**
 * ChatGPT.
 *
 * Every public description of this API, including our own design doc, says
 * the conversation is a `mapping{}` node graph walked from `current_node` by
 * parent pointers. That is out of date. A probe against a live account found
 * `messages`, a FLAT ordered array with no parent and no children, plus a
 * `page_info` with cursors. The server resolves the branch itself, so the
 * leaf-to-root walk the other providers need does not apply here.
 *
 * Confirmed by probe, not assumed:
 *   - `/api/auth/session` returns an `accessToken`.
 *   - List: `{items, total, limit, offset}`, newest first with `order=updated`.
 *   - List timestamps are ISO 8601 strings; MESSAGE `create_time` is a
 *     number. Two formats in one provider — see `isoFromEpoch`.
 *   - A 274-message conversation came back whole, `has_previous_page: false`.
 *   - `num_turns=1000` is a 422. That parameter went with the old API.
 *   - Roles seen: system, user, assistant, tool.
 *   - Content types seen: text, multimodal_text, code, execution_output,
 *     thoughts, reasoning_recap, model_editable_context.
 */

import { ProviderRequestError, ProviderShapeError } from "../types.js";
import type { Conversation, ConversationSummary, Message, ProviderAdapter } from "../types.js";
import { renderTranscript } from "../thread.js";

const ORIGIN = "https://chatgpt.com";
const PAGE_SIZE = 100;

/**
 * A hard stop on list paging.
 *
 * `since` normally ends it far sooner — the list is newest-first, so an
 * incremental sync stops at the first conversation it has already seen. This
 * only bites on a first run against a very large account, where it is a
 * deliberate "come back for the rest" rather than a silent truncation: the
 * run reports what it fetched and the next one resumes from the watermark.
 */
const MAX_PAGES = 50;

/**
 * Content types whose text is part of the conversation.
 *
 * An allowlist, not a blocklist. ChatGPT adds types over time — this probe
 * alone found seven — and a blocklist would quietly start letting new ones
 * through. What is deliberately absent:
 *
 *   thoughts, reasoning_recap   model reasoning; the user did not write it
 *                               and it inflates every transcript
 *   code, execution_output      the python tool, not the dialogue
 *   model_editable_context      custom instructions and memory, which are
 *                               settings rather than anything that was said
 */
const VISIBLE_CONTENT_TYPES = new Set(["text", "multimodal_text"]);

/** Roles a person would recognise as part of their conversation. */
const VISIBLE_ROLES = new Set(["user", "assistant"]);

interface ChatGptMessage {
  id?: unknown;
  author?: { role?: unknown } | null;
  create_time?: unknown;
  content?: { content_type?: unknown; parts?: unknown } | null;
  metadata?: { is_visually_hidden_from_conversation?: unknown } | null;
  recipient?: unknown;
}

export function conversationUrl(id: string): string {
  return `${ORIGIN}/c/${id}`;
}

/**
 * Epoch seconds to ISO 8601.
 *
 * The list sends ISO strings and the messages send numbers, in the same
 * provider, in the same sync. Everything downstream — the watermark's text
 * comparison, eMe's `content_at` — assumes ISO, so the numbers are converted
 * here rather than anywhere later.
 */
export function isoFromEpoch(value: unknown): string | null {
  if (typeof value === "string" && value !== "") return value;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  // Seconds, with a fractional part. Milliseconds would put every
  // conversation in 1970 — a wrong date that sorts and filters silently.
  return new Date(value * 1000).toISOString();
}

/** List rows → summaries, skipping anything that cannot be synced. */
export function parseConversationList(payload: unknown): ConversationSummary[] {
  const rows = (payload as { items?: unknown } | null)?.items;
  if (!Array.isArray(rows)) {
    throw new ProviderShapeError("chatgpt", "list response has no `items` array");
  }

  const summaries: ConversationSummary[] = [];
  for (const row of rows as Record<string, unknown>[]) {
    const id = typeof row?.id === "string" ? row.id : null;
    const created = isoFromEpoch(row?.create_time);
    const updated = isoFromEpoch(row?.update_time);
    // No id cannot be upserted; no date cannot be compared to a watermark or
    // filed by eMe, and a guessed date is worse than none.
    if (id === null || created === null) continue;
    summaries.push({
      id,
      title: typeof row?.title === "string" && row.title ? row.title : "Untitled",
      createdAt: created,
      updatedAt: updated ?? created,
    });
  }
  return summaries;
}

/**
 * Messages → the turns a person would recognise, in the order given.
 *
 * No tree walk: the array is flat and already resolved. Of 274 messages in
 * the probed conversation, 23 were system, 85 were tool, and 23 were flagged
 * hidden — so most of what arrives is not conversation, and keeping it would
 * mean embedding tool plumbing into the user's own search index.
 */
export function parseMessages(payload: unknown): Message[] {
  const rows = (payload as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(rows)) {
    throw new ProviderShapeError("chatgpt", "conversation response has no `messages` array");
  }

  const messages: Message[] = [];
  for (const row of rows as ChatGptMessage[]) {
    const id = typeof row?.id === "string" ? row.id : null;
    const role = row?.author?.role;
    const createdAt = isoFromEpoch(row?.create_time);
    if (id === null || typeof role !== "string" || !VISIBLE_ROLES.has(role)) continue;
    if (createdAt === null) continue;

    // The UI hides these; so do we. They are memory writes, tool scaffolding
    // and system notes that a person never saw.
    if (row?.metadata?.is_visually_hidden_from_conversation === true) continue;

    // Addressed to a tool rather than to the person. "all" means visible.
    if (typeof row?.recipient === "string" && row.recipient !== "all") continue;

    const text = visibleText(row?.content);
    if (text === null) continue;

    messages.push({
      id,
      // Flat and ordered, so nothing points anywhere. Kept null rather than
      // faked: `activePath` would otherwise reconstruct a chain that the
      // server has already resolved correctly.
      parentId: null,
      role: role === "user" ? "user" : "assistant",
      text,
      createdAt,
    });
  }
  return messages;
}

/** The human-readable text of one content block, or null to skip it. */
export function visibleText(content: unknown): string | null {
  const block = content as { content_type?: unknown; parts?: unknown } | null;
  const type = block?.content_type;
  if (typeof type !== "string" || !VISIBLE_CONTENT_TYPES.has(type)) return null;

  if (!Array.isArray(block?.parts)) return null;
  // `multimodal_text` mixes strings with objects describing images. Keep the
  // strings; an image pointer is not text and rendering it would put
  // "[object Object]" in the transcript.
  const text = block.parts
    .filter((part): part is string => typeof part === "string")
    .join("\n")
    .trim();
  return text === "" ? null : text;
}

/** Everything above, assembled into the record eMe stores. */
export function buildConversation(
  summary: ConversationSummary,
  payload: unknown,
  id: string,
): Conversation {
  requireWholeConversation(payload, id);

  const messages = parseMessages(payload);
  if (messages.length === 0) {
    throw new ProviderShapeError("chatgpt", `conversation ${id} yielded no visible messages`);
  }

  const detail = payload as { title?: unknown; default_model_slug?: unknown };
  const first = messages[0]!;
  const last = messages[messages.length - 1]!;

  return {
    id,
    title:
      typeof detail?.title === "string" && detail.title
        ? detail.title
        : summary.title || "Untitled",
    transcript: renderTranscript(messages),
    startedAt: first.createdAt,
    endedAt: last.createdAt,
    messageCount: messages.length,
    model: typeof detail?.default_model_slug === "string" ? detail.default_model_slug : null,
    url: conversationUrl(id),
  };
}

/**
 * Refuse a conversation we have only part of.
 *
 * `page_info.has_previous_page` says there are earlier messages behind a
 * cursor. The parameter for fetching them has not been observed — the probed
 * account's longest conversation, at 274 messages, came back whole — so
 * guessing it would mean either a wrong request or, worse, a transcript that
 * reads perfectly and is missing its beginning.
 *
 * So this fails loudly and names the one thing to capture. A partial
 * transcript stored as if complete is the failure this project keeps paying
 * for; a conversation that errors is visible in the sync report and can be
 * fixed in one round trip.
 */
export function requireWholeConversation(payload: unknown, id: string): void {
  const info = (payload as { page_info?: { has_previous_page?: unknown } | null } | null)
    ?.page_info;
  if (info?.has_previous_page === true) {
    throw new ProviderShapeError(
      "chatgpt",
      `conversation ${id} has earlier messages behind a cursor, and the ` +
        `request for them is not yet known. Capture the follow-up request ` +
        `the UI makes when scrolling to the top of a long conversation, and ` +
        `see page_info in src/providers/chatgpt.ts. Not stored, because half ` +
        `a transcript looks exactly like a whole one.`,
    );
  }
}

export const chatgpt: ProviderAdapter = {
  source: "chatgpt",
  origin: ORIGIN,

  async listConversations(since?: string): Promise<ConversationSummary[]> {
    const token = await accessToken();
    const all: ConversationSummary[] = [];

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const body = await getJson(
        `/backend-api/conversations?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}&order=updated`,
        token,
      );
      const batch = parseConversationList(body);
      all.push(...batch);

      if (batch.length < PAGE_SIZE) break;
      // Newest first, so once a page ends at or behind the watermark there
      // is nothing older worth asking for.
      if (since !== undefined && batch[batch.length - 1]!.updatedAt <= since) break;
    }
    return all;
  },

  async fetchConversation(id: string): Promise<Conversation> {
    const token = await accessToken();
    const payload = await getJson(`/backend-api/conversations/${id}`, token);
    const summary: ConversationSummary = { id, title: "", createdAt: "", updatedAt: "" };
    return buildConversation(summary, payload, id);
  },
};

/**
 * The bearer token, fetched fresh for each sync.
 *
 * Not optional and not cached across runs. Cookies alone do not fail — they
 * return an EMPTY LIST rather than a 401 — so a collector that skipped this
 * would report a signed-in user as having no conversations, sync nothing,
 * and look entirely healthy. Every silent-failure bug in this project has
 * had that shape.
 */
async function accessToken(): Promise<string> {
  const response = await fetch(`${ORIGIN}/api/auth/session`, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new ProviderRequestError(
      "chatgpt",
      `/api/auth/session returned ${response.status}. Sign in to chatgpt.com and retry.`,
    );
  }
  const body = (await response.json()) as { accessToken?: unknown };
  if (typeof body?.accessToken !== "string" || body.accessToken === "") {
    throw new ProviderShapeError(
      "chatgpt",
      "no accessToken in the session response — probably signed out. Not " +
        "treating this as an empty account: without the token the API " +
        "returns zero conversations rather than an error.",
    );
  }
  return body.accessToken;
}

async function getJson(path: string, token: string): Promise<unknown> {
  const response = await fetch(`${ORIGIN}${path}`, {
    credentials: "include",
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new ProviderRequestError("chatgpt", `GET ${path} returned ${response.status}`);
  }
  return response.json();
}
