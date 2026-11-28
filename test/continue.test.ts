/**
 * When to come back in a minute instead of on the hour.
 *
 * Each run is capped so no single sync walks an entire account. Waiting the
 * full hour to resume is a different matter: a first sync of 761
 * conversations would take thirty hours, and nothing on screen would suggest
 * it was still going.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { shouldContinueSoon } from "../src/schedule.js";
import type { SyncReport } from "../src/sync.js";

function report(over: Partial<SyncReport> = {}): SyncReport {
  return {
    source: "chatgpt",
    listed: 761,
    changed: 736,
    sent: 25,
    skipped: 0,
    failed: 0,
    empty: 0,
    messageCounts: [],
    errors: [],
    watermark: "2023-05-06T15:22:08Z",
    truncated: true,
    ...over,
  };
}

describe("shouldContinueSoon", () => {
  it("comes back soon when a run was capped and went well", () => {
    assert.equal(shouldContinueSoon([report()]), true);
  });

  it("waits for the hour when there was nothing left to do", () => {
    assert.equal(shouldContinueSoon([report({ truncated: false })]), false);
  });

  it("does not come straight back after an error", () => {
    // An error means the provider is unhappy or the payload has changed.
    // Returning in a minute would turn one problem into a tight loop against
    // someone else's server.
    assert.equal(shouldContinueSoon([report({ errors: ["429"] })]), false);
  });

  it("does not come straight back when the run stored nothing", () => {
    // Capped but empty means it is not actually progressing, so repeating
    // promptly just repeats the failure faster.
    assert.equal(shouldContinueSoon([report({ sent: 0 })]), false);
  });

  it("continues when any one provider has more to do", () => {
    assert.equal(
      shouldContinueSoon([report({ source: "grok", truncated: false }), report()]),
      true,
    );
  });

  it("does nothing with no reports at all", () => {
    assert.equal(shouldContinueSoon([]), false);
  });
});
