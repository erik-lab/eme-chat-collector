/**
 * When the next sync should run.
 *
 * Its own module because `background.ts` registers browser listeners at
 * import: a pure decision living there could only be tested by faking the
 * whole extension API, which would test the fake.
 */

import type { SyncReport } from "./sync.js";

/**
 * Should the next run follow in a minute rather than on the hour?
 *
 * Only when a run was capped AND it went well AND it actually stored
 * something. Each run is capped so no single sync walks an entire account,
 * which is right; waiting the full hour to resume is not, because a first
 * sync of 761 conversations would then take thirty hours with nothing on
 * screen to suggest it was still going.
 *
 * Errors mean the provider is unhappy or the payload has changed, and
 * returning in a minute would turn one problem into a tight loop against
 * someone else's server. A capped run that stored nothing is not
 * progressing either, so repeating it promptly only repeats the failure
 * faster.
 */
export function shouldContinueSoon(reports: SyncReport[]): boolean {
  return reports.some((r) => r.truncated && r.errors.length === 0 && r.sent > 0);
}
