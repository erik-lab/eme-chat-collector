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
| Grok | **Implemented**, verified complete | Cookies |
| ChatGPT | **Implemented** | Bearer token from `/api/auth/session` |
| Claude | **Implemented** | Cookies, plus an organization-UUID discovery step |
| Gemini | Deferred | — |

**Claude's notes were wrong in three places**, all found by probing before
writing. A message's flat `text` field is **empty** — the content is in a
typed `content[]`, and building on `text` as described would have collected
conversations containing nothing, which is not an error anywhere downstream,
just a record that never matches a search. An ordinary account has **two
organizations**, only one of which has the `chat` capability; taking the
first works by luck. And `?tree=True` changes nothing, so it is not sent.

Claude is the provider the shared leaf-to-root walk was written for: it
names `current_leaf_message_uuid` *and* every message carries
`parent_message_uuid`. Grok has the pointers but no leaf; ChatGPT resolves
the branch server-side and needs no walk at all.

**`rendering_mode=messages` is not optional.** Without it the response
carries a flat `text` per message and no `content` array; with it, `text` is
empty and the content is in typed blocks. Two probe runs disagreed about
which was true because one sent the parameter and the other did not. The
adapter reads the blocks — they are what makes dropping `thinking` possible,
since the flat rendering gives one string per message with no way to tell
reasoning from reply.

**Project conversations are in the ordinary list**, as ChatGPT's are: a
project's own endpoint returned nothing the main list did not already have.
A list row carries `project: {name, uuid}` when it belongs to one.

**A conversation's first message has a parent of
`00000000-0000-4000-8000-000000000000`** — a synthetic root the API never
returns, exactly as Grok does. The longest conversation found was 48
messages, with no `truncated` flags and no paging keys, so there is no
evidence of a cap.

**Still unverified**: whether the list includes archived conversations. The
probed account had none, and neither `archived=true` nor `is_archived=true`
filters — the second returns page one unchanged — so there is no parameter
to opt in with and nothing to count.

Gemini's web app speaks `batchexecute`, Google's positional-array RPC, and the
request needs a dated build string that changes with every deploy. That is a
protocol to reimplement and then maintain against a weekly-moving target; it
would cost more than the other three combined. Google Takeout does carry
Gemini Apps Activity, so a periodic import is the likelier route.

`GET …/responses` returns whole conversations, not the tail its UI needs —
checked by extending a thread and re-syncing, not assumed. Grok's first message
does carry a `parentResponseId` that is never in the array, which looks exactly
like evidence of truncation and is only how Grok roots a thread.

**Grok's two message endpoints are a trap worth knowing about.** Opening a
conversation fires both `GET …/responses` (the turns) and
`POST …/load-responses` (the UI's load-more). The second one returns `200`
with zero responses when asked for nothing in particular, so a collector built
on it reports an empty account rather than a wrong endpoint. The first guess
here was `GET …/load-responses`, which returns `501` — wrong, but loudly
wrong, which is the only reason it took one round trip to find.

**ChatGPT's failure mode is worth knowing in advance:** cookies alone return
*zero items*, not a `401`. A collector built on cookies would report "no
conversations" and look like an empty account. The adapter fetches the token
first and raises if it is missing, rather than letting an empty list stand.

**ChatGPT no longer returns the `mapping` node graph** every write-up of this
API describes, including our own design doc. A probe against a live account
found `messages` — a flat, ordered array with no parent and no children —
plus a `page_info` with cursors. The server resolves the branch itself, so
the leaf-to-root walk does not apply here at all.

A long conversation is paged: the first request returns the newest 50, and
`?before=<page_info.start_cursor>` walks backwards until
`has_previous_page` is false. Worth recording how the alternatives failed —
`cursor`, `start_cursor` and `after` each returned **200 with the same page
and `has_previous_page` still true**. Any of them would have looked like
working pagination and looped forever. A 404 would have been kinder, and
that is why the adapter refuses a page that returns nothing new rather than
trusting the status code.

Two more things that probe settled. The list sends ISO 8601 strings while
message `create_time` is a NUMBER, so one provider uses two timestamp formats
and the adapter converts. And `num_turns=1000` is a `422` — that parameter
went with the old API, and a 274-message conversation came back whole with
`has_previous_page: false`.

**Projects need no special handling.** A project conversation was confirmed
present in the ordinary list, carries an ordinary conversation id, and lives
under a project path (`/g/g-p-…/c/<id>`) only in the UI. The adapter already
collects them.

**Archived conversations are asked for separately.** The default list and
`is_archived=false` returned an identical 761 on the account this was built
against — which had zero archived conversations, so it cannot say whether
the default includes them. Both listings are fetched and unioned: one extra
request when there are none, against a quietly partial history for anyone
who files things away.

Most of what ChatGPT returns is not conversation. In that 274-message
thread: 23 system, 85 tool, 23 flagged hidden, and content types including
`thoughts`, `reasoning_recap`, `code`, `execution_output` and
`model_editable_context`. The adapter keeps `text` and `multimodal_text` from
`user` and `assistant`, by **allowlist** — one probe found seven content
types, and a blocklist would quietly start letting new ones through.

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

**After every `git pull`, rebuild and reload.** `dist/` is not in git, so a
pull alone changes nothing the browser runs:

```bash
git pull && npm run build      # then hit ⟳ on the extension card
```

Reloading the *page* does nothing — no content script is involved, the service
worker does the fetching itself. Every sync report carries the `buildId` it
came from, so a stale build is visible in the output rather than something to
wonder about.

Click the toolbar icon to open settings. Enter your eMe **API** URL and a key,
tick the providers you want, and **Save**. Nothing is collected until you do:
an extension that started shipping conversations the moment it was installed
would be the thing this project exists to object to. **Sync now** runs
immediately and prints the report, errors included.

After that it syncs hourly on a `chrome.alarms` schedule.

**A first sync works through your history in the background.** Each run is
capped so no single sync walks an entire account, and a run that hits the cap
schedules the next one a minute later instead of waiting the hour — 761
ChatGPT conversations take about half an hour rather than thirty. It resumes
after a browser restart, because the watermark is stored and the follow-up is
an alarm rather than a loop in memory: an MV3 service worker is killed
whenever the browser likes, and a long backfill held in memory would stop
silently partway.

A run that errored does **not** come straight back. Something being wrong is
not a reason to retry it sixty times an hour against someone else's server.

**Re-send everything** forgets the per-provider watermark, so the next sync
sends every conversation again. That is for when eMe learns to read a field the
extension was already sending — the stored records are stale but nothing looks
out of date, and no ordinary sync will fix them. It cannot duplicate anything:
each conversation is keyed on its own provider id and updates in place.

A report separates four outcomes, because they want four different
responses. `sent` is collected. `empty` is an unused chat — every provider
creates a conversation record the moment one is opened, so a real account
has a dozen, and listing them as errors is how an error list stops being
read. `failed` is a conversation the adapter could not represent, stepped
over with its id in `errors`. `skipped` is one still being generated, which
the next run picks up.

Each report lists `messageCounts`, the turn counts of what it sent, largest
first. That is a diagnostic rather than a statistic: a provider's message
endpoint may return the tail its UI needs rather than the whole conversation
(ChatGPT's `num_turns=10` does exactly that), and the tell is several
conversations reporting the same suspiciously round number.

### Getting the URL right

It is the URL your eMe **API** answers on, which is often not the address you
open in a browser: the bare origin usually serves the web client, with the API
behind a path prefix your proxy strips — `https://eme.example.com/v2/api`, say.
Copy whatever your eMe web client calls.

The giveaway is a sync reporting that **an HTML page came back, not eMe**. That
means a proxy or web server answered, so the path is wrong — not the key.

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
