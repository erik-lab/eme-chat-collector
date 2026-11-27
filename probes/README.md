# Endpoint probes

One file per chat provider. Paste the whole file into the devtools console on
that provider's site, signed in, and send the output back.

**They print structure only** — key names, counts, types, roles, and whether a
token exists. No message text, no titles, no credential values. The output is
safe to paste into a chat or an issue.

## Why these exist

The first Grok adapter was written against a guessed request shape. `GET
…/load-responses` returned **501**, which was the lucky outcome: the plausible
alternative, `POST …/load-responses` with no specific ids, returns **200 with
zero responses**, and a collector built on it reports an empty account rather
than a wrong endpoint. Nothing about that failure looks like a failure.

A probe costs one round trip and settles it. Writing the adapter first costs
at least two, and risks shipping something that quietly collects nothing.

## What each probe is looking for

Beyond "does this endpoint exist", three things have differed per provider and
each would be a silent bug:

- **Timestamp format.** Grok sends ISO 8601 strings; the sync compares
  watermarks as text, which is only correct for ISO instants. A provider
  sending epoch numbers needs conversion, or every comparison is wrong in a
  way that still looks like it works.
- **Whether the detail endpoint truncates.** ChatGPT's UI sends
  `num_turns=10`, which fetches the tail rather than the conversation. A
  truncated transcript reads perfectly and is missing its beginning.
- **The tree's dangling parents.** Grok's first message points at a synthetic
  root the API never returns. For a provider that pages its turns, the same
  shape means turns not yet fetched — the opposite conclusion from identical
  evidence.
