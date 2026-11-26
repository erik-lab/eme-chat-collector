/**
 * Flattening a branched conversation into the thread the user actually sees.
 *
 * Every provider stores conversations as a tree: editing a message or asking
 * for a different answer creates a sibling branch, and the old one stays.
 * They all record it the same way — each message points at its parent, and
 * the conversation points at its current leaf.
 *
 * Walking from the leaf back to the root and reversing gives the path the UI
 * displays. Taking the messages in the order the provider happened to return
 * them would interleave abandoned branches into a transcript that reads
 * perfectly and is not what happened — which is worse than an obvious
 * failure, because nothing about it looks wrong.
 */

import type { Message } from "./types.js";

/**
 * The active path, root first.
 *
 * `leafId` is the provider's current-leaf pointer. When it is null or names a
 * message that is not present, the thread is reconstructed from the newest
 * message instead, because a conversation we can partly read is worth more
 * than one we discard.
 */
export function activePath(messages: Message[], leafId: string | null): Message[] {
  if (messages.length === 0) return [];

  const byId = new Map(messages.map((m) => [m.id, m]));

  let cursor = leafId === null ? null : byId.get(leafId) ?? null;
  if (cursor === null) {
    cursor = newest(messages);
  }

  const reversed: Message[] = [];
  // A provider that returns a cycle would otherwise hang the service worker,
  // and a hang is the one failure a user cannot diagnose.
  const visited = new Set<string>();

  while (cursor !== null && !visited.has(cursor.id)) {
    visited.add(cursor.id);
    reversed.push(cursor);
    cursor = cursor.parentId === null ? null : byId.get(cursor.parentId) ?? null;
  }

  return reversed.reverse();
}

function newest(messages: Message[]): Message {
  // Non-null: the caller has already returned for an empty list.
  return messages.reduce((latest, m) => (m.createdAt > latest.createdAt ? m : latest), messages[0]!);
}

/**
 * The transcript eMe stores and searches.
 *
 * Role-prefixed plain text, because that is what reads well in a search
 * result and what chunks sensibly for embedding. Not the provider's JSON:
 * one short Grok exchange arrives carrying around forty web-search results
 * repeated four times over, and sending that raw would mean paying to
 * enrich search-result URLs and embedding other people's web pages into the
 * user's own index.
 */
export function renderTranscript(messages: Message[]): string {
  return messages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`)
    .join("\n\n");
}
