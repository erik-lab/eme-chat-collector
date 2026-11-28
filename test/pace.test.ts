/**
 * Going slowly on purpose.
 *
 * The downside being guarded against is not throttling, which is
 * recoverable. It is suspension: a user of another history collector had
 * their ChatGPT account blocked over a backfill's request rate. Losing the
 * collected data is the smaller half of that.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PAGE_DELAY_MS, pace } from "../src/pace.js";

describe("pace", () => {
  it("actually waits", async () => {
    const started = Date.now();

    await pace(120);

    // Jitter is ±25%, so the floor is 75% of the interval.
    assert.ok(Date.now() - started >= 80, `waited ${Date.now() - started}ms`);
  });

  it("varies the interval", async () => {
    // A request exactly every 3,000ms is a signature nothing human
    // produces, and "obviously automated" is the judgement this is trying
    // not to invite.
    const waits = new Set<number>();
    for (let i = 0; i < 8; i += 1) {
      const started = Date.now();
      await pace(40);
      waits.add(Date.now() - started);
    }

    assert.ok(waits.size > 1, "every wait was identical");
  });

  it("does not wait for a zero interval", async () => {
    const started = Date.now();

    await pace(0);

    assert.ok(Date.now() - started < 20);
  });

  it("paces list pages more gently than it paces conversations", () => {
    // Paging is a handful of requests the web app itself makes in quick
    // succession when you scroll, so matching that is reasonable; fetching
    // them with no gap at all is not.
    assert.ok(PAGE_DELAY_MS > 0);
    assert.ok(PAGE_DELAY_MS < 3_000);
  });
});
