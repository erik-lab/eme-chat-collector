/**
 * The two things the user has to tell us, and the sync state we keep.
 *
 * Nothing in this repository may contain a key or a host: both are the
 * user's own configuration, entered once and kept in `chrome.storage.local`,
 * which is this browser profile only. A test key committed to a public repo
 * is trivially avoidable now and embarrassing later.
 */

export interface Settings {
  /** The user's own eMe instance, e.g. "https://eme.example.com". No path. */
  baseUrl: string;
  /** An eMe API key. See the repo README on scopes — this one is unscoped. */
  apiKey: string;
  /** Providers the user has switched on. Nothing is collected by default. */
  enabled: string[];
}

/** Per-provider watermark: the newest `updatedAt` we have already sent. */
export type Watermarks = Record<string, string | undefined>;

const SETTINGS_KEY = "settings";
const WATERMARK_KEY = "watermarks";

export async function loadSettings(): Promise<Settings | null> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const raw = stored[SETTINGS_KEY] as Partial<Settings> | undefined;
  if (!raw || !raw.baseUrl || !raw.apiKey) return null;
  return {
    baseUrl: raw.baseUrl.replace(/\/+$/, ""),
    apiKey: raw.apiKey,
    enabled: raw.enabled ?? [],
  };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

export async function loadWatermarks(): Promise<Watermarks> {
  const stored = await chrome.storage.local.get(WATERMARK_KEY);
  return (stored[WATERMARK_KEY] as Watermarks | undefined) ?? {};
}

export async function setWatermark(source: string, value: string): Promise<void> {
  const current = await loadWatermarks();
  // Only ever move forward. A provider that returns an out-of-order row must
  // not drag the watermark back and cause the next sync to re-send history.
  const previous = current[source];
  if (previous !== undefined && previous >= value) return;
  current[source] = value;
  await chrome.storage.local.set({ [WATERMARK_KEY]: current });
}
