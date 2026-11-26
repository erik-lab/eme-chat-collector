# eMe Chat Collector

A browser extension that copies **your own** AI chat conversations into **your
own** [eMe](https://github.com/erik-lab/eMeV2) instance.

eMe exists to bring a person's online material under one interface — to break
through the garden walls the SaaS providers put up, gather the information that
is ours, protect it, and provide a way to search it. Chat conversations are
some of the most valuable material a person now produces, and every provider
keeps them behind a wall with an export button that does not work. This closes
that gap.

## How it works

The extension runs in your browser, in your own authenticated session, and
reads the same endpoints the chat UI itself calls. For each conversation it
sends eMe a **readable transcript** — role, text, timestamps — and nothing
else, then forgets it.

```
list conversations  →  fetch the ones that changed  →  POST /ingest/upsert
```

Two phases, because the list endpoints carry metadata only. The list is nearly
free; the per-conversation fetches are the part that looks like a crawl, so
they are paced and capped. An incremental sync usually costs one request,
because the list alone answers "has anything changed".

### What is sent, and what is not

| Sent | Not sent |
|---|---|
| Title | Web-search results and page previews |
| Role-prefixed transcript | Tool calls, tool results, attachment blobs |
| First and last message times | Model reasoning (`thinking` / `thoughts`) |
| Message count, model, link back | Branches you abandoned |
| | Anything the extension does not recognise |

Transforming at the edge is the most important thing this does. One short Grok
exchange — a one-line question and a poem in reply — arrives carrying around
forty web-search results, repeated four times over, plus a dozen empty arrays
per turn. The conversation itself is two fields. Most of the rest is *other
people's web pages*, and sending it would mean embedding scraped previews of
third-party sites into your own search index.

**Model reasoning is dropped on purpose.** It is not conversation, you did not
write it, and it inflates every transcript. The cost is real: a search for
something a model reasoned about but never said will not find it. Reversing
that decision later means re-ingesting, because what was not captured cannot
be recovered from what was.

**Branches are resolved, not concatenated.** Every provider stores
conversations as a tree — editing a message or regenerating a reply leaves the
old branch in place. The extension walks from the current leaf back to the
root and reverses, which is the thread the UI shows you. Taking the messages
in the order the provider returned them would produce a transcript that reads
perfectly and is not what happened.

## Providers

| Provider | Status | Auth |
|---|---|---|
| Grok | **Implemented** | Cookies |
| ChatGPT | Next | Bearer token from `/api/auth/session` |
| Claude | Next | Cookies, plus an organization-UUID discovery step |
| Gemini | Deferred | — |

Gemini's web app speaks `batchexecute`, Google's positional-array RPC, and the
request needs a dated build string that changes with every deploy. That is a
protocol to reimplement and then maintain against a weekly-moving target; it
would cost more than the other three combined. Google Takeout does carry
Gemini Apps Activity, so a periodic import is the likelier route.

**ChatGPT's failure mode is worth knowing in advance:** cookies alone return
*zero items*, not a `401`. A collector built on cookies would report "no
conversations" and look like an empty account. An empty ChatGPT list is
treated as suspicious, not final.

Adding an engine means implementing `ProviderAdapter` (`src/types.ts`) and
adding a line to `src/providers/index.ts`. The sync loop, the eMe client and
the backend do not change — the backend only ever sees a new `source` string.

Each engine is a **distinct eMe source** (`grok`, `chatgpt`, `claude`), not a
single `chat` source, so Finder can filter by engine and so one provider's
breakage does not look like another's.

## Install

Not in any store. Load it unpacked:

```bash
npm install
npm run check     # typecheck, tests, build
```

Then in Chrome: `chrome://extensions` → Developer mode → **Load unpacked** →
choose `dist/`.

Click the toolbar icon to open settings. Enter your eMe URL and an API key,
tick the providers you want, and **Save**. Nothing is collected until you do:
an extension that started shipping conversations the moment it was installed
would be the thing this project exists to object to. **Sync now** runs
immediately and prints the report, errors included.

After that it syncs hourly on a `chrome.alarms` schedule.

## Configuration, keys and the thing to fix before anyone else installs this

**Nothing in this repository contains a key or a host.** Both are your
configuration, kept in `chrome.storage.local`, which is this browser profile
only — not synced, never sent anywhere but your own eMe.

Because the host is yours and unknown at build time, it cannot be in the
manifest. The extension asks for permission to reach it when you save the URL,
for that one origin — which is also why Chrome shows a prompt at that moment
and not at install.

The key you paste today is an **unscoped eMe API key**: it can do everything
your account can. The extension needs exactly two things — write to
`/ingest/upsert` and read enough sync state to know what it has sent — and
there is currently no way to issue a key limited to that.

So, plainly:

1. **Now.** Build against a pasted key. One user, who issued the key, on their
   own machine.
2. **Before anyone outside the project installs this.** Key scopes in eMe, and
   mint the extension's token as ingest-only.
3. **Same milestone.** A connect flow (`chrome.identity.launchWebAuthFlow`), so
   no key is ever seen or copied and the URL is the only thing anyone types.

Steps 2 and 3 are tracked in the eMe backlog. Blocking step 1 on them would be
gold-plating for an audience of one; shipping them late would be handing
strangers a full-access credential in browser storage.

## Design

The full record — why an extension rather than an MCP server or a partner
integration, how each provider was mapped, what was measured and what was
decided against — is in
[`docs/chat-collection-design.md`](https://github.com/erik-lab/eMeV2/blob/main/docs/chat-collection-design.md)
in the backend repo.

## Terms, and being honest about them

Provider terms generally prohibit automated access, even to your own data.
"The user's own data, in the user's own authenticated session, going to storage
the user controls" is a defensible position — but it is a position, not a
permission. The extension reads at human pace, caps each run, and does only
what the UI in front of you already does.

## Layout

```
manifest.json          MV3: four provider hosts, and your eMe granted at runtime
options.html           Settings page
src/types.ts           ProviderAdapter, and the three shapes everything reduces to
src/thread.ts          The leaf→root walk every provider shares
src/sync.ts            List, early-stop at the watermark, fetch, upsert
src/eme.ts             POST /ingest/upsert
src/settings.ts        chrome.storage.local, and the per-provider watermark
src/providers/grok.ts  Grok
src/background.ts      Service worker: alarms, messages
test/                  node:test, run with `npm test`
```

The bundle is **not minified**, on purpose. The main claim this extension makes
is that a sceptical person can read it in an afternoon, and a minified bundle
in a public repo whose point is auditability defeats the point.

## License

MIT.
