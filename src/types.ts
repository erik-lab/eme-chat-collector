/**
 * The shapes every provider is reduced to.
 *
 * Each chat provider returns something different — ChatGPT a `mapping{}` node
 * graph, Claude a `chat_messages[]` array, Grok a `responses[]` array — and
 * every one of them is a TREE, because editing a message or regenerating a
 * reply branches the thread. An adapter's job is to turn its provider into
 * these three types and nothing else.
 *
 * See docs/chat-collection-design.md in the eMeV2 repo for how each provider
 * was mapped and why.
 */

/** One turn, after the provider's own envelope has been stripped away. */
export interface Message {
  /** The provider's id for this message. Used to walk the tree, not stored. */
  id: string;
  /** Null for the root. */
  parentId: string | null;
  role: "user" | "assistant";
  /** Human-visible text only. Model reasoning is dropped; see extract(). */
  text: string;
  /** ISO 8601. */
  createdAt: string;
}

/** A conversation as it appears in a provider's list endpoint. */
export interface ConversationSummary {
  id: string;
  title: string;
  /** ISO 8601. The change watermark — a sync compares against this. */
  updatedAt: string;
  createdAt: string;
}

/** What gets sent to eMe. Mirrors the payload in the design doc. */
export interface Conversation {
  id: string;
  title: string;
  transcript: string;
  startedAt: string;
  endedAt: string;
  messageCount: number;
  model: string | null;
  url: string;
}

/**
 * Everything provider-specific, behind one interface.
 *
 * Adding an engine is implementing this — no change to the sync loop, the
 * eMe client, or the backend, which only ever sees a new `source` string.
 */
export interface ProviderAdapter {
  /** eMe's `source` for this engine. One per engine, deliberately. */
  readonly source: string;

  /** Hosts this adapter talks to, for the manifest and for sanity checks. */
  readonly origin: string;

  /**
   * Every conversation the account has, newest first where the provider
   * offers an order.
   *
   * Providers differ on paging: ChatGPT takes limit/offset and orders by
   * update time, Grok ignores both and returns everything. That difference
   * lives in here.
   *
   * `since` is the sync watermark, and is a HINT, not a filter. A provider
   * that returns newest-first may stop paging once it is past it, which is
   * what keeps an incremental sync on a large account to one request instead
   * of twenty. A provider that cannot order, or returns everything anyway,
   * ignores it. Either way the caller filters again, so returning too much
   * is correct and returning too little is not.
   */
  listConversations(since?: string): Promise<ConversationSummary[]>;

  /** The full thread for one conversation, already flattened to the active branch. */
  fetchConversation(id: string): Promise<Conversation>;
}

/**
 * Thrown when a conversation is still being generated.
 *
 * Not an error: the user is mid-chat. Storing it now would persist half an
 * answer and then never revisit it, because the watermark would have moved
 * past it. The sync leaves it for the next run instead.
 */
export class ConversationNotSettled extends Error {
  constructor(provider: string, id: string) {
    super(`${provider}: conversation ${id} is still generating`);
    this.name = "ConversationNotSettled";
  }
}

/**
 * Thrown when a REQUEST fails — a bad status, a refused connection.
 *
 * Distinct from a shape error because the two deserve opposite responses. A
 * conversation whose payload we cannot read is one bad record, and the other
 * seven hundred should still be collected. A 429 or a 500 is the provider
 * telling us to stop, and walking the rest of the list would be hammering it.
 */
export class ProviderRequestError extends Error {
  constructor(provider: string, detail: string) {
    super(`${provider}: ${detail}`);
    this.name = "ProviderRequestError";
  }
}

/** Thrown when a provider answers in a shape we do not recognise. */
export class ProviderShapeError extends Error {
  constructor(provider: string, detail: string) {
    super(`${provider}: ${detail}`);
    this.name = "ProviderShapeError";
  }
}
