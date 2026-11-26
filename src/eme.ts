/**
 * The one call this extension makes to the user's own server.
 *
 * `POST /ingest/upsert`, keyed on the provider's conversation id, so
 * re-sending is free and a conversation that continued updates in place
 * rather than arriving twice.
 */

import type { Conversation } from "./types.js";
import type { Settings } from "./settings.js";

export interface UpsertResult {
  ok: boolean;
  status: number;
  /** Present when the server refused, for the error the user actually sees. */
  detail?: string;
}

export async function upsertConversation(
  settings: Settings,
  source: string,
  conversation: Conversation,
): Promise<UpsertResult> {
  const body = {
    id: conversation.id,
    source,
    object_type: "conversation",
    raw_json: {
      title: conversation.title,
      transcript: conversation.transcript,
      started_at: conversation.startedAt,
      ended_at: conversation.endedAt,
      message_count: conversation.messageCount,
      model: conversation.model,
      url: conversation.url,
    },
  };

  const response = await fetch(`${settings.baseUrl}/ingest/upsert`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify(body),
    // The user's eMe is a different origin from the chat provider whose tab
    // this may run in, and it authenticates by the key above — never by a
    // cookie that happens to be lying around.
    credentials: "omit",
  });

  if (response.ok) return { ok: true, status: response.status };

  // Read the body: a 401 from a bad key and a 422 from a payload the server
  // did not like are the same colour to a user staring at "sync failed".
  let detail: string;
  try {
    detail = (await response.text()).slice(0, 500);
  } catch {
    detail = "<no body>";
  }
  return { ok: false, status: response.status, detail };
}
