/**
 * Grok.
 *
 * First of the three because it is the simplest: cookie auth, no pagination,
 * and a flat `responses[]` array with a parent pointer. It proves the whole
 * shape — list, fetch, extract, upsert — before ChatGPT's bearer token and
 * node-graph add variables.
 *
 * The payload is also the clearest argument for transforming at the edge. One
 * short exchange — a one-line question and a poem in reply — came back with
 * around forty web-search results, repeated four times over across `steps[]`,
 * `toolUsageResults[]` and `raw_function_result`, plus a dozen empty arrays
 * per turn. The conversation itself was two `message` fields. Everything else
 * is provider plumbing, and much of it is other people's web pages. Sending
 * it raw would mean embedding scraped previews of third-party sites into the
 * user's own search index.
 */

import { ConversationNotSettled, ProviderShapeError } from "../types.js";
import type { Conversation, ConversationSummary, Message, ProviderAdapter } from "../types.js";
import { activePath, renderTranscript } from "../thread.js";

const ORIGIN = "https://grok.com";

/**
 * Confirmed by hand: returns `{conversations: [...]}`, ordered by
 * `modifyTime` descending, with every conversation the account has.
 *
 * `limit=10`, `limit=2` and `max=2` were all ignored, so there is nothing to
 * page. That is the easy case — but it has only been checked on an account
 * with a handful of conversations. On one with thousands it is a large
 * response on every sync, and the early-stop below is what keeps the
 * expensive half (the per-conversation fetches) proportional to what changed.
 */
const LIST_PATH = "/rest/app-chat/conversations";

/**
 * Confirmed by probe, after a first guess was wrong.
 *
 * Opening a conversation in the UI fires two requests, and the obvious-looking
 * one is the wrong one. `GET …/responses` returns
 * `{responses, inflightResponses}` — the actual turns. `load-responses` is the
 * UI's load-more follow-on: `POST` it with an empty `responseIds` and it
 * returns zero responses quite happily, which is how a collector built on it
 * would report an empty account instead of a wrong endpoint.
 *
 * The first attempt here was `GET …/load-responses`, which returns **501** —
 * the endpoint is real and does not take GET. That is a better failure than
 * the 200-with-nothing that the POST would have given, and only because the
 * guess was wrong in the loud direction.
 *
 * Verified complete, not a tail. Sixteen collected conversations all reported
 * exactly two turns, which looks precisely like ChatGPT's `num_turns=10`
 * truncation — and was not: they were sixteen one-shot questions. Adding turns
 * to one of them and re-syncing reported six. So `/responses` returns the whole
 * conversation and there is nothing to page.
 *
 * The thing that made this look like a cap is worth writing down, because it
 * will come up again. Grok's first message carries a `parentResponseId` that is
 * NOT in the array — a synthetic root the endpoint never returns. A dangling
 * parent normally means "there are turns you have not fetched", so it reads as
 * evidence of truncation. Here it is just how Grok roots a thread.
 */
const MESSAGES_PATH = (id: string) => `/rest/app-chat/conversations/${id}/responses`;

/** A list row, as `/conversations` returns it. */
interface GrokConversationRow {
  conversationId?: unknown;
  title?: unknown;
  createTime?: unknown;
  modifyTime?: unknown;
}

/** One turn, as `load-responses` returns it — the four fields we keep. */
interface GrokResponseRow {
  responseId?: unknown;
  message?: unknown;
  sender?: unknown;
  createTime?: unknown;
  parentResponseId?: unknown;
  model?: unknown;
}

export function conversationUrl(id: string): string {
  return `${ORIGIN}/chat/${id}`;
}

/**
 * List rows → summaries, skipping anything malformed.
 *
 * A row missing an id or a timestamp cannot be synced or compared against a
 * watermark, so it is dropped rather than sent with a guessed date. An
 * undated record is placed by its ingest time and reports no date at all —
 * a lesson already paid for with Dropbox.
 */
export function parseConversationList(payload: unknown): ConversationSummary[] {
  const rows = (payload as { conversations?: unknown } | null)?.conversations;
  if (!Array.isArray(rows)) {
    throw new ProviderShapeError("grok", "list response has no `conversations` array");
  }

  const summaries: ConversationSummary[] = [];
  for (const row of rows as GrokConversationRow[]) {
    const id = str(row?.conversationId);
    const createTime = str(row?.createTime);
    const modifyTime = str(row?.modifyTime);
    if (id === null || createTime === null) continue;
    summaries.push({
      id,
      title: str(row?.title) ?? "Untitled",
      createdAt: createTime,
      // Grok has always sent both, but a conversation that was never edited
      // is unchanged since it was created, which is the safe reading.
      updatedAt: modifyTime ?? createTime,
    });
  }
  return summaries;
}

/**
 * Response rows → messages.
 *
 * Keeps `sender`, `message`, `createTime` and the parent pointer. Discards
 * everything else, deliberately and by omission rather than by a blocklist:
 * Grok adds fields over time, and a blocklist would quietly start letting
 * new ones through.
 */
export function parseResponses(payload: unknown): Message[] {
  const rows = (payload as { responses?: unknown } | null)?.responses;
  if (!Array.isArray(rows)) {
    throw new ProviderShapeError("grok", "message response has no `responses` array");
  }

  const messages: Message[] = [];
  for (const row of rows as GrokResponseRow[]) {
    const id = str(row?.responseId);
    const createTime = str(row?.createTime);
    const role = asRole(row?.sender);
    const text = str(row?.message);
    // An unknown sender is a shape we do not understand; skip it rather than
    // attribute someone's words to the wrong speaker.
    if (id === null || createTime === null || role === null || text === null) continue;
    messages.push({
      id,
      parentId: str(row?.parentResponseId),
      role,
      text,
      createdAt: createTime,
    });
  }
  return messages;
}

/** True while Grok is still generating a reply. */
export function isGenerating(payload: unknown): boolean {
  const inflight = (payload as { inflightResponses?: unknown } | null)?.inflightResponses;
  return Array.isArray(inflight) && inflight.length > 0;
}

/** The model named on the last assistant turn, if Grok named one. */
export function parseModel(payload: unknown): string | null {
  const rows = (payload as { responses?: unknown } | null)?.responses;
  if (!Array.isArray(rows)) return null;
  for (const row of [...(rows as GrokResponseRow[])].reverse()) {
    const model = str(row?.model);
    if (model !== null && model !== "") return model;
  }
  return null;
}

/**
 * Everything above, assembled into the record eMe stores.
 *
 * Grok names no current leaf, so the thread is reconstructed from the newest
 * message — see `activePath`.
 */
export function buildConversation(summary: ConversationSummary, payload: unknown): Conversation {
  // Grok tells us when it has not finished talking. Taking it at its word
  // costs one skipped conversation and saves storing half an answer under a
  // watermark that would never come back for the rest.
  if (isGenerating(payload)) throw new ConversationNotSettled("grok", summary.id);

  const path = activePath(parseResponses(payload), null);
  if (path.length === 0) {
    throw new ProviderShapeError("grok", `conversation ${summary.id} yielded no messages`);
  }

  const first = path[0]!;
  const last = path[path.length - 1]!;
  return {
    id: summary.id,
    title: summary.title,
    transcript: renderTranscript(path),
    // From the messages, not from the list row: the list's `createTime` is
    // when the conversation record was made, and these are when the user
    // actually spoke.
    startedAt: first.createdAt,
    endedAt: last.createdAt,
    messageCount: path.length,
    model: parseModel(payload),
    url: conversationUrl(summary.id),
  };
}

export const grok: ProviderAdapter = {
  source: "grok",
  origin: ORIGIN,

  async listConversations(): Promise<ConversationSummary[]> {
    return parseConversationList(await getJson(LIST_PATH));
  },

  async fetchConversation(id: string): Promise<Conversation> {
    const payload = await getJson(MESSAGES_PATH(id));
    const summaries = await this.listConversations();
    const summary = summaries.find((s) => s.id === id);
    return buildConversation(
      summary ?? { id, title: "Untitled", createdAt: "", updatedAt: "" },
      payload,
    );
  },
};

async function getJson(path: string): Promise<unknown> {
  const response = await fetch(`${ORIGIN}${path}`, {
    // Cookie auth: this runs with the user's own Grok session, which is the
    // whole premise — their data, their session, their storage.
    credentials: "include",
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    throw new ProviderShapeError(
      "grok",
      `GET ${path} returned ${response.status}. A 404, 405 or 501 means the ` +
        `request shape in src/providers/grok.ts is wrong, not that the ` +
        `account is empty — 501 in particular means the endpoint is there and ` +
        `does not take GET. Re-capture the request from devtools.`,
    );
  }
  return response.json();
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asRole(sender: unknown): "user" | "assistant" | null {
  if (sender === "human") return "user";
  if (sender === "assistant") return "assistant";
  return null;
}
