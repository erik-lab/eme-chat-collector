/**
 * Going slowly on purpose.
 *
 * The risk this guards against is not being throttled, which is recoverable.
 * It is having the account suspended: a user of another history collector
 * had their ChatGPT account blocked for rate violations caused by its
 * backfill. Losing the data is the smaller half of that — losing the account
 * the data came from is the larger one.
 *
 * So the rule here is that slower is safer, and safer is faster: a backfill
 * that takes two hours and finishes beats one that takes twenty minutes and
 * gets the account locked at minute fifteen.
 *
 * What a rate limiter actually notices is bursts, not averages. Sixteen list
 * pages fetched back to back look nothing like a person, even if the hourly
 * total is modest — so every repeated request goes through here.
 */

/** Set to false by tests, so a suite does not spend real seconds waiting. */
let pacingEnabled = true;

/** Test-only. The name is deliberately hard to mistake for configuration. */
export function disablePacingForTests(): void {
  pacingEnabled = false;
}

/**
 * Wait, with the interval varied by ±25%.
 *
 * Jittered because a perfectly regular request every 3,000ms is a signature
 * nothing human produces, and "obviously automated" is the judgement this
 * is trying not to invite.
 */
export function pace(ms: number): Promise<void> {
  if (!pacingEnabled || ms <= 0) return Promise.resolve();
  const spread = ms * 0.25;
  const wait = ms - spread + Math.random() * spread * 2;
  return new Promise((resolve) => setTimeout(resolve, wait));
}

/**
 * Between pages of a list, and between pages of one conversation.
 *
 * Shorter than the gap between conversations: paging is a handful of
 * requests that the web app itself makes in quick succession when you
 * scroll, so matching that is reasonable. Fetching them with no gap at all
 * is not.
 */
export const PAGE_DELAY_MS = 1_200;
