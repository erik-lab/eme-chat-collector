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
});

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

export async function syncAll(): Promise<SyncReport[]> {
  const settings = await loadSettings();
  if (settings === null) return [];

  const reports: SyncReport[] = [];
  for (const adapter of PROVIDERS) {
    if (!settings.enabled.includes(adapter.source)) continue;
    reports.push(await runOne(adapter.source));
  }
  await recordReports(reports);
  return reports;
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
