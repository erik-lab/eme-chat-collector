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

import { ConversationEmpty, ProviderRequestError, ProviderShapeError } from "../types.js";
import type { Conversation, ConversationSummary, Message, ProviderAdapter } from "../types.js";
import { renderTranscript } from "../thread.js";
import { PAGE_DELAY_MS, pace } from "../pace.js";

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
 * A ceiling on walking one conversation backwards, at 50 messages a page.
 * Generous — 2,500 messages is an extraordinary thread — and present only so
 * a paging bug cannot spin forever.
 */
const MAX_MESSAGE_PAGES = 50;

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

  const raw = (payload as { messages?: unknown[] } | null)?.messages ?? [];
  if (raw.length === 0) throw new ConversationEmpty("chatgpt", id);

  const messages = parseMessages(payload);
  if (messages.length === 0) {
    // Records present, none readable. Not an empty chat — more likely the
    // content allowlist has fallen behind a new block type, which is worth
    // hearing about rather than filing under "nothing to collect".
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
 * A last check that the paging below actually finished.
 *
 * Reached only if the loop exited with more to fetch, which should be
 * impossible. Half a transcript looks exactly like a whole one, so the
 * impossible case errors rather than being stored.
 */
export function requireWholeConversation(payload: unknown, id: string): void {
  const info = pageInfo(payload);
  if (info?.has_previous_page === true) {
    throw new ProviderShapeError(
      "chatgpt",
      `conversation ${id} still reports earlier messages after paging. Not ` +
        `stored, because half a transcript looks exactly like a whole one.`,
    );
  }
}

interface PageInfo {
  start_cursor?: unknown;
  has_previous_page?: unknown;
}

export function pageInfo(payload: unknown): PageInfo | null {
  const info = (payload as { page_info?: unknown } | null)?.page_info;
  return info && typeof info === "object" ? (info as PageInfo) : null;
}

/** The raw message array, untouched, for stitching pages together. */
function rawMessages(payload: unknown): unknown[] {
  const rows = (payload as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(rows)) {
    throw new ProviderShapeError("chatgpt", "conversation response has no `messages` array");
  }
  return rows;
}

function rawId(row: unknown): string | null {
  const id = (row as { id?: unknown } | null)?.id;
  return typeof id === "string" ? id : null;
}

/**
 * Walk a conversation backwards until it is whole.
 *
 * The first request returns the NEWEST page — 50 messages, with
 * `page_info.has_previous_page` true when there are more. The rest come from
 * `?before=<start_cursor>`, each page earlier than the last, so pages are
 * prepended.
 *
 * `before` is the parameter, found by trying several against a conversation
 * known to be paged. The others are worth recording because of how they
 * fail: `cursor`, `start_cursor` and `after` all return **200 with the same
 * page and has_previous_page still true**. Any of them would have looked
 * like working pagination and looped forever, re-fetching page one and
 * believing it was making progress. A 404 would have been kinder.
 *
 * Freshness is checked on RAW ids rather than on parsed messages: a page can
 * legitimately contain nothing but system and tool messages, which parse to
 * nothing, and treating that as "no progress" would abort a conversation
 * that was paging correctly.
 */
async function fetchAllPages(id: string, token: string): Promise<unknown> {
  const detail = await getJson(`/backend-api/conversations/${id}`, token);
  let messages = rawMessages(detail);
  const seen = new Set(messages.map(rawId).filter((x): x is string => x !== null));

  let info = pageInfo(detail);
  let fetched = 1;

  while (info?.has_previous_page === true) {
    if (typeof info.start_cursor !== "string" || info.start_cursor === "") {
      throw new ProviderShapeError(
        "chatgpt",
        `conversation ${id} reports earlier messages but gives no cursor`,
      );
    }
    if (fetched >= MAX_MESSAGE_PAGES) {
      throw new ProviderShapeError(
        "chatgpt",
        `conversation ${id} is still paging after ${MAX_MESSAGE_PAGES} requests`,
      );
    }

    await pace(PAGE_DELAY_MS);
    const page = await getJson(
      `/backend-api/conversations/${id}?before=${encodeURIComponent(info.start_cursor)}`,
      token,
    );
    fetched += 1;

    const batch = rawMessages(page);
    const fresh = batch.filter((row) => {
      const rid = rawId(row);
      return rid !== null && !seen.has(rid);
    });
    if (fresh.length === 0) {
      // The loop trap, caught rather than ridden. Three other parameter
      // names produce exactly this, and a collector that kept going would
      // spin until the browser stopped it.
      throw new ProviderShapeError(
        "chatgpt",
        `conversation ${id} returned no earlier messages for its cursor — ` +
          `paging is not advancing, so the request shape has changed`,
      );
    }
    fresh.forEach((row) => seen.add(rawId(row)!));
    messages = [...fresh, ...messages];
    info = pageInfo(page);
  }

  return { ...(detail as object), messages, page_info: info ?? { has_previous_page: false } };
}

export const chatgpt: ProviderAdapter = {
  source: "chatgpt",
  origin: ORIGIN,

  async listConversations(since?: string): Promise<ConversationSummary[]> {
    const token = await accessToken();

    // Two listings, unioned by id.
    //
    // The default one returned exactly the same 761 conversations as
    // `is_archived=false` on the account this was built against — but that
    // account had ZERO archived conversations, so it cannot say whether the
    // default includes them. Asking explicitly costs one request when there
    // are none, and is the difference between a complete history and a
    // quietly partial one for anybody who files things away.
    //
    // Projects need no such treatment: a project conversation was confirmed
    // present in the default list, carries an ordinary conversation id, and
    // lives under a project path only in the UI.
    const byId = new Map<string, ConversationSummary>();
    for (const extra of ["", "&is_archived=true"]) {
      for (const summary of await pageList(token, extra, since)) {
        byId.set(summary.id, summary);
      }
    }
    return [...byId.values()];
  },

  async fetchConversation(id: string): Promise<Conversation> {
    const token = await accessToken();
    const payload = await fetchAllPages(id, token);
    const summary: ConversationSummary = { id, title: "", createdAt: "", updatedAt: "" };
    return buildConversation(summary, payload, id);
  },
};

/** Page one conversations listing until it runs out, or past the watermark. */
async function pageList(
  token: string,
  extraQuery: string,
  since: string | undefined,
): Promise<ConversationSummary[]> {
  const all: ConversationSummary[] = [];

  for (let page = 0; page < MAX_PAGES; page += 1) {
    if (page > 0) await pace(PAGE_DELAY_MS);
    const body = await getJson(
      `/backend-api/conversations?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}` +
        `&order=updated${extraQuery}`,
      token,
    );
    const batch = parseConversationList(body);
    all.push(...batch);

    if (batch.length < PAGE_SIZE) break;
    // Newest first, so once a page ends at or behind the watermark there is
    // nothing older worth asking for. Note this stops on the PAGE's oldest
    // row, not the first row past the mark: the caller filters again, and
    // over-fetching one page is cheaper than reasoning about an off-by-one
    // that would silently drop a conversation.
    if (since !== undefined && batch[batch.length - 1]!.updatedAt <= since) break;
  }
  return all;
}

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
