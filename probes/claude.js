/**
 * Claude.ai endpoint probe. Paste into the devtools console on claude.ai.
 *
 * Prints STRUCTURE ONLY — key names, counts, types, roles, uuid prefixes.
 * No titles, no project names, no organization names, no message text.
 * Safe to paste back.
 *
 * Written before the adapter, deliberately. The documented ChatGPT shape
 * turned out to be two years stale — no `mapping`, a `messages` array
 * instead, and a `before=` cursor nobody had written down. What this project
 * believes about Claude comes from the same vintage of notes, so none of it
 * is assumed here.
 *
 * What the notes claim, each of which this checks rather than trusts:
 *   - the URL carries an ORGANIZATION uuid, so there is a discovery step
 *   - the list defaults to `archived=false`, so archived chats are invisible
 *     unless asked for — the same trap ChatGPT turned out not to have
 *   - the detail endpoint takes `?tree=True` and returns `chat_messages[]`
 *   - each message has `uuid`, `parent_message_uuid`, `sender`, `created_at`,
 *     `text` and a typed `content[]`
 *   - the conversation names its leaf as `current_leaf_message_uuid`
 *
 * If the last two hold, Claude is the provider the shared leaf-to-root walk
 * was written for — Grok needed it with a synthetic root, ChatGPT turned out
 * not to need it at all.
 */
(async () => {
  const log = (...a) => console.log("[probe]", ...a);
  const typeOf = (v) =>
    v === null ? "null" : Array.isArray(v) ? `array(${v.length})` : typeof v;
  const head = (v) => (typeof v === "string" ? v.slice(0, 8) + "…" : typeOf(v));

  const get = async (path) => {
    const r = await fetch(path, {
      credentials: "include",
      headers: { Accept: "application/json" },
    });
    return { status: r.status, body: r.ok ? await r.json().catch(() => null) : null };
  };

  // 1. Auth and the organization. Cookie auth is claimed; if that is wrong
  //    everything below fails the same way and the status code says so.
  const orgs = await get("/api/organizations");
  log("organizations:", orgs.status, typeOf(orgs.body));
  const list = Array.isArray(orgs.body) ? orgs.body : (orgs.body?.items ?? []);
  if (!list.length) return log("no organizations — signed out, or the path has changed");
  log("  count =", list.length, "| entry keys =", Object.keys(list[0]));
  // Several orgs is the awkward case: which one holds the chats?
  list.forEach((o, i) =>
    log(`  [${i}] uuid=${head(o.uuid ?? o.id)}`, "capabilities =", JSON.stringify(o.capabilities)),
  );
  const org = (list[0].uuid ?? list[0].id);

  // 2. The list. Shape, paging and — the thing that bit us twice — the
  //    timestamp format and whether any count it reports can be trusted.
  const base = `/api/organizations/${org}/chat_conversations`;
  const conv = await get(`${base}?limit=20&offset=0`);
  log("conversations:", conv.status, "top-level =", typeOf(conv.body));
  const items = Array.isArray(conv.body) ? conv.body : (conv.body?.items ?? []);
  log("  returned =", items.length);
  if (!items.length) return log("no conversations returned — stop here");
  log("  item keys =", Object.keys(items[0]));
  for (const k of ["uuid", "created_at", "updated_at", "name", "is_starred"]) {
    if (k in items[0]) log(`  ${k}: ${typeOf(items[0][k])} ${k.endsWith("_at") ? JSON.stringify(items[0][k]) : ""}`);
  }

  // Does limit/offset actually page, or is it ignored the way Grok's was?
  const page2 = await get(`${base}?limit=20&offset=20`);
  const p2 = Array.isArray(page2.body) ? page2.body : (page2.body?.items ?? []);
  const overlap = p2.filter((c) => items.some((i) => i.uuid === c.uuid)).length;
  log(`  offset=20 → ${p2.length} item(s), ${overlap} of them also on page 1`);
  log("   → overlap greater than zero means offset is being ignored");

  // 3. Archived. The claim is that the list hides them by default. Counting
  //    ITEMS, not any `total`: ChatGPT's total said 21 for 761.
  for (const qs of ["archived=true", "is_archived=true"]) {
    const r = await get(`${base}?limit=20&offset=0&${qs}`);
    const rows = Array.isArray(r.body) ? r.body : (r.body?.items ?? []);
    const fresh = rows.filter((c) => !items.some((i) => i.uuid === c.uuid)).length;
    log(`  ?${qs} → ${r.status}, ${rows.length} item(s), ${fresh} not on page 1`);
  }

  // 4. Projects. Claude has them too, and for ChatGPT the answer turned out
  //    to be "already in the ordinary list, nothing to do". Worth asking
  //    before building anything.
  for (const path of [`/api/organizations/${org}/projects`, `/api/organizations/${org}/projects?limit=5`]) {
    const r = await get(path);
    const rows = Array.isArray(r.body) ? r.body : (r.body?.items ?? []);
    log(`  GET ${path.split("?")[0]} → ${r.status}, ${rows.length} item(s)`);
    if (rows[0]) log("    project keys =", Object.keys(rows[0]));
  }

  // 5. The conversation itself. `tree=True` is the claim; both are tried
  //    because a parameter that silently does nothing is the dangerous case.
  const id = items[0].uuid;
  const plain = await get(`${base}/${id}`);
  const tree = await get(`${base}/${id}?tree=True&rendering_mode=messages`);
  const msgsOf = (b) => b?.chat_messages ?? b?.messages ?? [];
  log(`detail plain → ${plain.status}, ${msgsOf(plain.body).length} message(s)`);
  log(`detail tree  → ${tree.status}, ${msgsOf(tree.body).length} message(s)`);

  const body = tree.body ?? plain.body ?? {};
  log("detail keys =", Object.keys(body));
  log("current_leaf_message_uuid =", head(body.current_leaf_message_uuid));

  const messages = msgsOf(body);
  if (!messages.length) return log("no messages — stop here");
  log("message keys =", Object.keys(messages[0]));

  const senders = {};
  const contentTypes = {};
  let withParent = 0;
  let timeType = null;
  for (const m of messages) {
    senders[m.sender ?? m.role ?? "?"] = (senders[m.sender ?? m.role ?? "?"] ?? 0) + 1;
    if (m.parent_message_uuid) withParent += 1;
    for (const block of m.content ?? []) {
      const t = block?.type ?? "?";
      contentTypes[t] = (contentTypes[t] ?? 0) + 1;
    }
    timeType ??= typeOf(m.created_at);
  }
  log("senders =", senders);
  log("content block types =", contentTypes);
  log(`messages with a parent pointer = ${withParent} of ${messages.length}`);
  log("created_at type =", timeType);
  log("leaf is among the messages =", messages.some((m) => m.uuid === body.current_leaf_message_uuid));

  // 6. Where the visible text lives. Notes say both a flat `text` and a
  //    typed `content[]` exist; if they disagree, the adapter has to choose.
  const sample = messages.find((m) => (m.content ?? []).length);
  if (sample) {
    log("sample message: has flat text =", typeof sample.text === "string" && sample.text !== "");
    log("  content block keys per type:");
    const seen = new Set();
    for (const block of sample.content ?? []) {
      if (seen.has(block.type)) continue;
      seen.add(block.type);
      log(`    ${block.type} →`, JSON.stringify(Object.keys(block)));
    }
    const flat = typeof sample.text === "string" ? sample.text.length : 0;
    const fromBlocks = (sample.content ?? [])
      .filter((b) => b.type === "text")
      .reduce((n, b) => n + (b.text?.length ?? 0), 0);
    log(`  length: flat text ${flat}, text blocks ${fromBlocks}`);
    log("   → if these differ, one of them is incomplete and the adapter must pick");
  }

  // 7. Does the detail endpoint page, as ChatGPT's turned out to?
  log("page_info-ish keys =", Object.keys(body).filter((k) => /page|cursor|has_|limit|offset/i.test(k)));
})();
