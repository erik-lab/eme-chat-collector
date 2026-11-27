/**
 * The sync loop, which is the same for every provider.
 *
 * Two phases, because the list endpoints carry metadata only: one cheap
 * request to find out what changed, then one request per conversation that
 * did. An incremental sync usually costs exactly one request, because the
 * list alone answers "has anything changed".
 *
 * That split is also where the politeness lives. The list is nearly free. The
 * per-conversation fetches are the part that looks like a crawl, so they are
 * paced and capped.
 */

import type { ConversationSummary, ProviderAdapter } from "./types.js";
import type { Settings } from "./settings.js";
import { upsertConversation } from "./eme.js";
import { ConversationNotSettled } from "./types.js";

export interface SyncOptions {
  /** Only conversations changed after this are fetched. */
  since?: string | undefined;
  /** Ceiling on per-conversation fetches in one run. */
  maxConversations?: number;
  /** Pause between per-conversation fetches, in milliseconds. */
  delayMs?: number;
  /** Injectable for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

export interface SyncReport {
  source: string;
  /** Rows the list returned. */
  listed: number;
  /** Rows newer than the watermark. */
  changed: number;
  /** Conversations successfully stored in eMe. */
  sent: number;
  /**
   * Conversations left alone because they were still being generated. Not a
   * failure — the next run picks them up.
   */
  skipped: number;
  /** One line per conversation that failed, so a run never fails silently. */
  errors: string[];
  /** The newest `updatedAt` actually sent. The caller stores it. */
  watermark: string | undefined;
  /**
   * True when the cap stopped the run before it reached the watermark, so the
   * caller knows to come back rather than treat the sync as complete.
   */
  truncated: boolean;
}

const DEFAULT_MAX = 25;
const DEFAULT_DELAY_MS = 1_500;

export async function syncProvider(
  adapter: ProviderAdapter,
  settings: Settings,
  options: SyncOptions = {},
): Promise<SyncReport> {
  const max = options.maxConversations ?? DEFAULT_MAX;
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  const sleep = options.sleep ?? realSleep;

  const listed = await adapter.listConversations();
  const changed = selectChanged(listed, options.since);

  const report: SyncReport = {
    source: adapter.source,
    listed: listed.length,
    changed: changed.length,
    sent: 0,
    skipped: 0,
    errors: [],
    watermark: options.since,
    truncated: changed.length > max,
  };

  // Oldest first, so an interrupted run leaves a watermark it can resume
  // from. Newest first would advance the watermark past conversations it
  // never sent, and they would never be collected.
  const batch = [...changed].reverse().slice(0, max);

  for (const [index, summary] of batch.entries()) {
    if (index > 0 && delayMs > 0) await sleep(delayMs);
    try {
      const conversation = await adapter.fetchConversation(summary.id);
      const result = await upsertConversation(settings, adapter.source, conversation);
      if (!result.ok) {
        report.errors.push(`${summary.id}: eMe returned ${result.status} ${result.detail ?? ""}`);
        // A rejected upsert must not advance the watermark past this
        // conversation, or it is lost. Stop and let the next run retry.
        break;
      }
      report.sent += 1;
      report.watermark = summary.updatedAt;
    } catch (error) {
      // Mid-generation is the normal state of whatever the user is typing in
      // right now, so it is reported as skipped rather than as a failure.
      // Either way the run stops: this batch is oldest-first, so everything
      // after this is newer and the watermark cannot move past it.
      if (error instanceof ConversationNotSettled) report.skipped += 1;
      else report.errors.push(`${summary.id}: ${describe(error)}`);
      break;
    }
  }

  return report;
}

/**
 * The rows worth fetching, newest first.
 *
 * Providers order their lists newest-first, so this stops at the first row
 * at or behind the watermark rather than walking all of history. On a first
 * run there is no watermark and everything is new.
 */
export function selectChanged(
  listed: ConversationSummary[],
  since: string | undefined,
): ConversationSummary[] {
  if (since === undefined) return [...listed];

  const changed: ConversationSummary[] = [];
  for (const summary of listed) {
    // ISO 8601 UTC strings compare correctly as text, which is the only
    // reason this is a string comparison and not a parse. Anything that is
    // not plainly a UTC instant must be parsed, not compared.
    if (summary.updatedAt <= since) break;
    changed.push(summary);
  }
  return changed;
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
