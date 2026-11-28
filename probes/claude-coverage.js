/**
 * Claude.ai COVERAGE probe — what the list leaves out, and what a long
 * conversation looks like.
 *
 * Paste into the devtools console on claude.ai. Counts, types and uuid
 * prefixes only: no names, no titles, no message text.
 *
 * Round 1 settled the shapes and overturned the notes in three places:
 *
 *   - The flat `text` on a message is EMPTY; the content is in `content[]`.
 *     Building on `text`, as the notes describe, would have collected
 *     conversations with nothing in them.
 *   - There are TWO organizations, and only the one with "chat" in its
 *     capabilities holds conversations. Taking the first happens to work and
 *     is luck.
 *   - `tree=True` changes nothing, and neither `archived=true` nor
 *     `is_archived=true` filters — the latter returns page one unchanged.
 *
 * Confirmed and useful: ISO timestamps, working limit/offset paging,
 * `current_leaf_message_uuid` present and among the messages, every message
 * carrying a parent pointer, senders human/assistant, content blocks of type
 * text and thinking.
 *
 * Four things remain, and each decides a line of the adapter.
 */
(async () => {
  const log = (...a) => console.log("[probe]", ...a);
  const get = async (path) => {
    const r = await fetch(path, { credentials: "include", headers: { Accept: "application/json" } });
    return { status: r.status, body: r.ok ? await r.json().catch(() => null) : null };
  };
  const rows = (b) => (Array.isArray(b) ? b : (b?.items ?? []));

  // The org that actually holds chats, by capability rather than by position.
  const orgs = rows((await get("/api/organizations")).body);
  const org = orgs.find((o) => (o.capabilities ?? []).includes("chat")) ?? orgs[0];
  log("using org", String(org?.uuid).slice(0, 8) + "…", "caps =", JSON.stringify(org?.capabilities));
  const base = `/api/organizations/${org.uuid}/chat_conversations`;

  // 1. The whole list, paged out. Then: does it CONTAIN archived ones, and
  //    does it contain project ones? Both fields are on the item, so this is
  //    a count rather than a guess — and counting beats trusting a filter
  //    parameter that was shown to be ignored.
  const all = [];
  for (let page = 0; page < 60; page += 1) {
    const batch = rows((await get(`${base}?limit=100&offset=${page * 100}`)).body);
    all.push(...batch);
    if (batch.length < 100) break;
  }
  const archived = all.filter((c) => c.is_archived).length;
  const inProject = all.filter((c) => c.project).length;
  log(`list: ${all.length} conversation(s)`);
  log(`  with is_archived true = ${archived}`);
  log(`  with a project        = ${inProject}`);
  log("   → archived at zero on an account that HAS archived chats means the list omits them");
  if (all.find((c) => c.project)) {
    log("  project field shape =", JSON.stringify(Object.keys(all.find((c) => c.project).project)));
  }

  // 2. Projects, and whether their conversations are the same ones. For
  //    ChatGPT the answer was "already in the ordinary list, nothing to do".
  const projects = rows((await get(`/api/organizations/${org.uuid}/projects`)).body);
  log(`projects: ${projects.length}`);
  const withDocs = projects[0];
  if (withDocs) {
    for (const path of [
      `/api/organizations/${org.uuid}/projects/${withDocs.uuid}/conversations`,
      `${base}?project_uuid=${withDocs.uuid}&limit=20`,
    ]) {
      const r = await get(path);
      const got = rows(r.body);
      const missing = got.filter((c) => !all.some((a) => a.uuid === c.uuid)).length;
      log(`  GET ${path.split("?")[0].replace(org.uuid, "…")} → ${r.status}, ${got.length} item(s), ${missing} absent from the main list`);
    }
  }

  // 3. The longest conversation. Round 1 inspected the newest, which had
  //    four messages — the same mistake that hid ChatGPT's cursor for a
  //    round. Only a long thread shows truncation or paging.
  let longest = null;
  let best = -1;
  for (const c of all.slice(0, 40)) {
    const body = (await get(`${base}/${c.uuid}`)).body;
    const n = (body?.chat_messages ?? []).length;
    if (n > best) {
      best = n;
      longest = body;
    }
  }
  log(`longest of the 40 newest: ${best} message(s)`);
  const messages = longest?.chat_messages ?? [];
  log("  suspiciously round?", [50, 100, 200].includes(best) ? "YES — looks like a cap" : "no");
  log("  messages flagged truncated =", messages.filter((m) => m.truncated).length);
  log("  paging-ish keys =", Object.keys(longest ?? {}).filter((k) => /page|cursor|has_|limit|offset/i.test(k)));

  const types = {};
  const senders = {};
  let emptyFlat = 0;
  for (const m of messages) {
    senders[m.sender] = (senders[m.sender] ?? 0) + 1;
    if (!m.text) emptyFlat += 1;
    for (const b of m.content ?? []) types[b?.type ?? "?"] = (types[b?.type ?? "?"] ?? 0) + 1;
  }
  log("  senders =", senders);
  log("  content block types =", types);
  log(`  messages with an EMPTY flat text = ${emptyFlat} of ${messages.length}`);

  // 4. What the first message's parent points at. Grok's root points at a
  //    synthetic id the API never returns, which read exactly like evidence
  //    of truncation and was not. Knowing Claude's answer up front avoids
  //    repeating that.
  const byId = new Set(messages.map((m) => m.uuid));
  const dangling = [...new Set(messages.map((m) => m.parent_message_uuid).filter((p) => p && !byId.has(p)))];
  log("  parents pointing outside the set =", dangling.length);
  dangling.slice(0, 3).forEach((d) => log("    →", d));
  log("   → one all-zero uuid is a synthetic root; anything else may be unfetched turns");
})();
