/**
 * The service worker.
 *
 * MV3 workers are killed whenever the browser feels like it, so nothing is
 * held in memory between runs: the watermark lives in `chrome.storage.local`
 * and an alarm — not a timer — brings the worker back.
 *
 * Nothing is collected until the user has entered their eMe URL and key and
 * switched a provider on. An extension that started shipping conversations
 * the moment it was installed would be exactly the thing this project exists
 * to object to.
 */

import { BUILD_ID } from "./build-info.js";
import { clearWatermarks, loadSettings, loadWatermarks, setWatermark } from "./settings.js";
import { PROVIDERS, providerBySource } from "./providers/index.js";
import { shouldContinueSoon } from "./schedule.js";
import { syncProvider, type SyncReport } from "./sync.js";

const ALARM = "eme-sync";
const PERIOD_MINUTES = 60;

/**
 * A one-shot follow-up, for when a run ended with known work left.
 *
 * Each run is capped so no single sync walks an entire account, which is
 * right. Waiting the full hour to resume is not: a first sync of 761
 * conversations would take thirty hours, and the user has no reason to think
 * it is still going.
 *
 * An alarm rather than a loop because MV3 service workers are killed
 * whenever the browser likes. A long-running backfill in memory would stop
 * silently partway; an alarm survives the worker dying.
 */
const CONTINUE_ALARM = "eme-sync-continue";
const CONTINUE_MINUTES = 1;

chrome.runtime.onInstalled.addListener(() => {
  void chrome.alarms.create(ALARM, { periodInMinutes: PERIOD_MINUTES });
  void resumeIfUnfinished();
});

// A browser restart. The periodic alarm survives it; a pending one-shot
// continuation does not.
chrome.runtime.onStartup.addListener(() => {
  void resumeIfUnfinished();
});

/**
 * Pick a backfill back up after a reload or a restart.
 *
 * Reloading the extension destroys its pending alarms, and the one-shot
 * continuation is how a capped run arranges the next one. So a reload part
 * way through a backfill silently drops it back to the hourly schedule, and
 * the work crawls instead of finishing.
 *
 * That is not hypothetical: a 761-conversation backfill reached 82 over an
 * afternoon of frequent reloads, when a minute-apart chain would have
 * finished it in half an hour. Nothing reported a problem, because nothing
 * had failed — the schedule had simply been forgotten.
 *
 * So the last report is consulted at startup, and an unfinished one is
 * resumed. It reads the stored report rather than syncing unconditionally:
 * starting a provider sync on every reload would hammer the providers
 * during development, which is when reloads happen most.
 */
async function resumeIfUnfinished(): Promise<void> {
  const stored = await chrome.storage.local.get("lastReports");
  const reports = (stored.lastReports as SyncReport[] | undefined) ?? [];
  if (shouldContinueSoon(reports)) {
    await chrome.alarms.create(CONTINUE_ALARM, { delayInMinutes: CONTINUE_MINUTES });
  }
}

/** Clicking the toolbar icon opens the settings page. */
chrome.action.onClicked.addListener(() => {
  void chrome.runtime.openOptionsPage();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM || alarm.name === CONTINUE_ALARM) void syncAll();
});

/** The popup asks for a sync, or for the last run's report. */
chrome.runtime.onMessage.addListener((message: unknown, _sender, respond) => {
  const kind = (message as { kind?: unknown } | null)?.kind;
  if (kind === "sync-now") {
    const source = (message as { source?: unknown }).source;
    void (typeof source === "string" ? syncOne(source) : syncAll())
      // The build stamp travels with the result, so a report pasted into a
      // bug thread says which code produced it.
      .then((reports) => respond({ buildId: BUILD_ID, ranAt: new Date().toISOString(), reports }))
      .catch((error: unknown) => respond({ buildId: BUILD_ID, error: String(error) }));
    return true; // response is async
  }
  if (kind === "forget") {
    const source = (message as { source?: unknown }).source;
    void clearWatermarks(typeof source === "string" ? [source] : undefined).then(() =>
      respond({ ok: true }),
    );
    return true;
  }
  if (kind === "last-report") {
    void chrome.storage.local.get("lastReports").then((s) => respond(s.lastReports ?? []));
    return true;
  }
  return false;
});

/**
 * How long a run may hold the lock before another may start.
 *
 * Generous: a capped run of 25 conversations at three seconds apart, plus
 * paged lists, is a few minutes. The ceiling exists only so a worker killed
 * mid-run cannot block syncing forever — MV3 kills them whenever it likes,
 * and a lock with no expiry would mean the backfill simply stopped one day.
 */
const LOCK_STALE_MS = 15 * 60 * 1000;
const LOCK_KEY = "syncStartedAt";

/**
 * Run the enabled providers, unless a run is already going.
 *
 * Without this, two alarms can overlap: a run now takes longer than the
 * minute between continuations, so the next one fires while the first is
 * still fetching. That doubles the request rate against providers we are
 * deliberately being gentle with, and races two writers on the same
 * watermark.
 *
 * The lock is in storage rather than in memory because the worker that took
 * it may not be the one that would check it.
 */
export async function syncAll(): Promise<SyncReport[]> {
  const settings = await loadSettings();
  if (settings === null) return [];

  const held = await chrome.storage.local.get(LOCK_KEY);
  const startedAt = held[LOCK_KEY] as number | undefined;
  if (startedAt !== undefined && Date.now() - startedAt < LOCK_STALE_MS) {
    return [];
  }
  await chrome.storage.local.set({ [LOCK_KEY]: Date.now() });

  try {
    const reports: SyncReport[] = [];
    for (const adapter of PROVIDERS) {
      if (!settings.enabled.includes(adapter.source)) continue;
      reports.push(await runOne(adapter.source));
    }
    await recordReports(reports);
    return reports;
  } finally {
    await chrome.storage.local.remove(LOCK_KEY);
  }
}

async function syncOne(source: string): Promise<SyncReport[]> {
  const reports = [await runOne(source)];
  await recordReports(reports);
  return reports;
}

async function runOne(source: string): Promise<SyncReport> {
  const empty = (errors: string[]): SyncReport => ({
    source,
    listed: 0,
    changed: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
    empty: 0,
    messageCounts: [],
    errors,
    watermark: undefined,
    truncated: false,
  });

  const settings = await loadSettings();
  if (settings === null) return empty(["eMe URL and API key are not set"]);

  const adapter = providerBySource(source);
  if (adapter === undefined) return empty([`no adapter for "${source}"`]);

  const watermarks = await loadWatermarks();
  const report = await syncProvider(adapter, settings, { since: watermarks[source] });

  if (report.watermark !== undefined && report.watermark !== watermarks[source]) {
    await setWatermark(source, report.watermark);
  }
  return report;
}

async function recordReports(reports: SyncReport[]): Promise<void> {
  // Kept so the popup can show what happened, including the errors. A sync
  // that failed and said nothing is worse than one that failed loudly.
  await chrome.storage.local.set({
    lastReports: reports,
    lastRunAt: new Date().toISOString(),
    buildId: BUILD_ID,
  });

  if (shouldContinueSoon(reports)) {
    await chrome.alarms.create(CONTINUE_ALARM, { delayInMinutes: CONTINUE_MINUTES });
  }
}
