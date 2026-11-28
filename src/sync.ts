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
import { pace } from "./pace.js";
import { ConversationEmpty, ConversationNotSettled, ProviderShapeError } from "./types.js";

export interface SyncOptions {
  /** Only conversations changed after this are fetched. */
  since?: string | undefined;
  /** Ceiling on per-conversation fetches in one run. */
  maxConversations?: number;
  /** Pause between per-conversation fetches, in milliseconds. */
  delayMs?: number;
  /** Injectable for tests; defaults to a real, jittered wait. */
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
   * Conversations the adapter could not represent, which the run stepped
   * over. Their ids are in `errors`; a re-send retries them.
   */
  failed: number;
  /**
   * Conversations with nothing in them. Every provider creates a record the
   * moment a new chat is opened, so an account collects ones that were
   * never used. Counted rather than listed as errors: an error list people
   * learn to ignore is worse than no error list.
   */
  empty: number;
  /**
   * Turn counts of what was sent, largest first.
   *
   * A diagnostic, not a statistic. Every provider's message endpoint might be
   * returning the tail the UI needs rather than the whole conversation —
   * ChatGPT's `num_turns=10` does exactly that — and the tell is a cap: several
   * conversations reporting the same suspiciously round number. Without this
   * the only way to notice is to read a long transcript and realise its
   * beginning is missing, which is not a thing anyone does.
   */
  messageCounts: number[];
  /**
   * Conversations left alone because they were still being generated. Not a
   * failure — the next run picks them up.
   */
  skipped: number;
  /**
   * One line per conversation that failed, so a run never fails silently.
   *
   * Capped: a systemic failure would otherwise write one of these for every
   * conversation in the account, burying the first and only useful one.
   */
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
/**
 * Between conversations.
 *
 * Raised from 1,500ms after a reminder of what the downside actually is: a
 * user of another collector had their ChatGPT account blocked over a
 * backfill's request rate. Being throttled is recoverable; losing the
 * account the data lives in is not, and no amount of finishing quickly is
 * worth risking it.
 *
 * At this rate a 761-conversation backfill takes a couple of hours in the
 * background rather than half an hour. Nobody is waiting on it.
 */
const DEFAULT_DELAY_MS = 3_000;

/** Enough to see the pattern; not one per conversation in the account. */
const MAX_REPORTED_ERRORS = 10;

/** In a row. Beyond this it is the payload shape, not one odd record. */
const MAX_CONSECUTIVE_FAILURES = 5;

export async function syncProvider(
  adapter: ProviderAdapter,
  settings: Settings,
  options: SyncOptions = {},
): Promise<SyncReport> {
  const max = options.maxConversations ?? DEFAULT_MAX;
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  const sleep = options.sleep ?? pace;

  // The watermark goes in as a hint: a provider that pages newest-first can
  // stop early instead of walking all of history. selectChanged filters
  // again regardless, so an adapter that ignores it is still correct.
  const listed = await adapter.listConversations(options.since);
  const changed = selectChanged(listed, options.since);

  const report: SyncReport = {
    source: adapter.source,
    listed: listed.length,
    changed: changed.length,
    sent: 0,
    skipped: 0,
    failed: 0,
    empty: 0,
    messageCounts: [],
    errors: [],
    watermark: options.since,
    truncated: changed.length > max,
  };

  // Oldest first, so an interrupted run leaves a watermark it can resume
  // from. Newest first would advance the watermark past conversations it
  // never sent, and they would never be collected.
  const batch = [...changed].reverse().slice(0, max);

  let consecutiveFailures = 0;

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
      consecutiveFailures = 0;
      report.messageCounts.push(conversation.messageCount);
      report.watermark = summary.updatedAt;
    } catch (error) {
      // Mid-generation is the normal state of whatever the user is typing in
      // right now, so the run stops and comes back rather than storing half
      // an answer. This batch is oldest-first, so everything after it is
      // newer and the watermark cannot move past it anyway.
      if (error instanceof ConversationNotSettled) {
        report.skipped += 1;
        break;
      }

      // An unused chat. Nothing to collect and nothing wrong, so the
      // watermark moves past it and it is never looked at again. Counted,
      // not reported: a first sync of someone's account will find a dozen,
      // and a dozen error lines for a dozen non-problems is how an error
      // list stops being read.
      if (error instanceof ConversationEmpty) {
        report.empty += 1;
        report.watermark = summary.updatedAt;
        continue;
      }

      // One unreadable conversation is one bad record, not a reason to
      // abandon the other seven hundred. The first real ChatGPT sync listed
      // 761 conversations, hit a payload it could not represent on the
      // OLDEST one, and stored nothing at all — a single record holding an
      // entire history hostage.
      //
      // The watermark does move past it. That loses the record until a
      // re-send, which is visible in the report, and is the better trade:
      // blocking forever is invisible progress, and an id in an error list
      // is something a person can act on.
      if (error instanceof ProviderShapeError) {
        consecutiveFailures += 1;
        if (report.errors.length < MAX_REPORTED_ERRORS) {
          report.errors.push(`${summary.id}: ${describe(error)}`);
        }
        report.failed += 1;
        report.watermark = summary.updatedAt;
        // Several in a row is not bad luck, it is something systematic — a
        // changed payload shape, most likely. Stop and say so rather than
        // walking the whole account producing identical errors.
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          report.errors.push(
            `stopped after ${consecutiveFailures} consecutive failures — ` +
              `this looks systematic rather than one bad conversation`,
          );
          break;
        }
        continue;
      }

      // A bad status or a refused connection: the provider is telling us to
      // stop, and walking the rest of the list would be hammering it.
      report.errors.push(`${summary.id}: ${describe(error)}`);
      break;
    }
  }

  report.messageCounts.sort((a, b) => b - a);
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

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
