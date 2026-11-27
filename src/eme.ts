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
      // `X-API-Key`, not `Authorization: Bearer`. The endpoint takes either an
      // eMe API key in this header or a Supabase JWT as a bearer token, and a
      // key sent as a bearer token is read as a JWT and rejected. The first
      // version of this sent Bearer and would have failed with "invalid
      // token" on a perfectly good key.
      "X-API-Key": settings.apiKey,
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
  let refusal: string;
  try {
    refusal = await response.text();
  } catch {
    refusal = "";
  }
  return { ok: false, status: response.status, detail: explain(response.status, refusal) };
}

/**
 * Turn a refusal into something that names the likely cause.
 *
 * The one worth special-casing is an HTML body, which means a reverse proxy
 * answered instead of eMe — so the URL is wrong, not the key or the payload.
 * Self-hosting behind a proxy makes this the most likely first-run failure:
 * eMe's own API usually sits under a path prefix, while the bare origin
 * serves the web client. Dumping Apache's 404 page into the report says
 * nothing; saying "a proxy answered, check the path" says all of it.
 */
export function explain(status: number, body: string): string {
  const trimmed = body.trim();
  const isHtml = /^<(!doctype|html)/i.test(trimmed);

  if (isHtml) {
    return (
      `${status} — an HTML page came back, not eMe. A proxy or web server ` +
      `answered, so the eMe URL is probably missing its API path. Check it ` +
      `against the URL your eMe web client calls.`
    );
  }
  if (status === 401 || status === 403) {
    return `${status} — eMe rejected the API key. ${snippet(trimmed)}`;
  }
  if (status === 429) {
    return `${status} — eMe's ingest rate limit. The next sync will carry on. ${snippet(trimmed)}`;
  }
  if (status === 404) {
    return `${status} — eMe has no /ingest/upsert at that URL. ${snippet(trimmed)}`;
  }
  return `${status} ${snippet(trimmed)}`;
}

function snippet(body: string): string {
  return body === "" ? "<no body>" : body.slice(0, 300);
}
