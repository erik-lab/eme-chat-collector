/**
 * The settings page: the eMe URL, the key, and which providers are on.
 *
 * Deliberately plain. The one field that cannot be removed is the URL —
 * self-hosting means the user has to say *which* eMe — and with the connect
 * flow (backlog) the key field goes away too, leaving that URL as the only
 * thing anyone ever types.
 */

import { loadSettings, saveSettings, loadWatermarks } from "./settings.js";
import { PROVIDERS } from "./providers/index.js";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

async function render(): Promise<void> {
  const settings = await loadSettings();
  $<HTMLInputElement>("base-url").value = settings?.baseUrl ?? "";
  $<HTMLInputElement>("api-key").value = settings?.apiKey ?? "";

  const list = $("providers");
  list.replaceChildren();
  const watermarks = await loadWatermarks();
  for (const provider of PROVIDERS) {
    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.value = provider.source;
    box.checked = settings?.enabled.includes(provider.source) ?? false;
    const synced = watermarks[provider.source];
    label.append(
      box,
      document.createTextNode(
        ` ${provider.source}${synced === undefined ? " — never synced" : ` — up to ${synced}`}`,
      ),
    );
    list.append(label);
  }
}

$("save").addEventListener("click", async () => {
  const enabled = [...document.querySelectorAll<HTMLInputElement>("#providers input:checked")].map(
    (box) => box.value,
  );
  const baseUrl = $<HTMLInputElement>("base-url").value.trim();

  // The eMe host cannot be in the manifest — it is the user's own server, and
  // this extension ships knowing no host at all. So it is an optional
  // permission, granted here, for the one origin the user just named.
  //
  // Without it the upsert fails on CORS from the service worker, which looks
  // like a server problem rather than a missing permission.
  if (!(await requestHostAccess(baseUrl))) {
    $("status").textContent =
      `Not saved: this extension needs permission to reach ${baseUrl}. ` +
      `Click Save again and allow it.`;
    return;
  }

  await saveSettings({ baseUrl, apiKey: $<HTMLInputElement>("api-key").value.trim(), enabled });
  $("status").textContent = "Saved.";
});

async function requestHostAccess(baseUrl: string): Promise<boolean> {
  let origin: string;
  try {
    origin = `${new URL(baseUrl).origin}/*`;
  } catch {
    return false;
  }
  if (await chrome.permissions.contains({ origins: [origin] })) return true;
  return chrome.permissions.request({ origins: [origin] });
}

$("sync").addEventListener("click", async () => {
  $("status").textContent = "Syncing…";
  // Whatever happened, including the errors. A sync that failed and said
  // nothing is worse than one that failed loudly.
  const reports = await chrome.runtime.sendMessage({ kind: "sync-now" });
  $("status").textContent = JSON.stringify(reports, null, 2);
  await render();
});

void render();
