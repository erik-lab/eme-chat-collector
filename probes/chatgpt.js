/**
 * ChatGPT endpoint probe. Paste into the devtools console on chatgpt.com.
 *
 * Prints STRUCTURE ONLY — key names, counts, types, roles. No message text,
 * no titles, no token value. Safe to paste back into a chat.
 *
 * Round 1 settled three things and overturned a fourth:
 *   - `/api/auth/session` returns an accessToken (length ~2000).
 *   - The list is {items, total, limit, offset}, newest first.
 *   - Timestamps are ISO 8601 STRINGS, not the epoch floats the older API
 *     sent. So no conversion, and the watermark's text comparison is right.
 *   - There is NO `mapping` any more. The detail response carries `messages`,
 *     `page_info` and `context_truncation_continuation`. The node-graph shape
 *     every write-up describes is out of date, and `page_info` means paging
 *     is explicit rather than something to infer.
 *
 * Round 2, below, characterises that: is `messages` flat or still a tree, what
 * is in `page_info`, and does the endpoint hand back a whole conversation.
 */
(async () => {
  const log = (...a) => console.log("[probe]", ...a);
  const typeOf = (v) =>
    v === null ? "null" : Array.isArray(v) ? `array(${v.length})` : typeof v;
  const shape = (v) => (v && typeof v === "object" ? Object.keys(v) : typeOf(v));

  const session = await (await fetch("/api/auth/session", { credentials: "include" })).json();
  const auth = session.accessToken ? { Authorization: `Bearer ${session.accessToken}` } : {};
  if (!session.accessToken) return log("auth: NO TOKEN — stop, nothing below is meaningful");

  const get = async (path) => {
    const r = await fetch(path, { credentials: "include", headers: auth });
    return { status: r.status, body: r.ok ? await r.json() : null };
  };

  const list = await get("/backend-api/conversations?limit=20&offset=0&order=updated");
  const items = list.body?.items ?? [];
  log("list:", items.length, "of", list.body?.total, "total");

  // The longest conversation available, by message count under the new shape.
  let longest = null;
  let best = -1;
  for (const item of items) {
    const r = await get(`/backend-api/conversations/${item.id}`);
    const n = (r.body?.messages ?? []).length;
    log(`  ${item.id.slice(0, 8)} → ${n} message(s)`);
    if (n > best) {
      best = n;
      longest = item.id;
    }
  }
  if (!longest) return log("detail: nothing to inspect");
  log("detail: inspecting", longest.slice(0, 8), "with", best, "messages");

  const full = (await get(`/backend-api/conversations/${longest}`)).body ?? {};
  const messages = full.messages ?? [];

  // 1. Flat list, or still a tree? This decides whether the shared leaf→root
  //    walk applies or whether the server has already resolved the branch.
  log("messages: element keys =", shape(messages[0]));
  const first = messages[0] ?? {};
  const inner = first.message ?? first;
  log("messages: inner keys =", shape(inner));
  log("messages: has parent pointer =", "parent" in first || "parent" in inner);
  log("messages: has children =", "children" in first || "children" in inner);
  log("messages: current_node =", full.current_node ? "present" : "absent");
  const ids = new Set(messages.map((m) => (m.message ?? m).id));
  log("messages: current_node is among them =", ids.has(full.current_node));

  // 2. Paging. `page_info` is the whole reason to ask whether one request
  //    returns a whole conversation — a truncated transcript reads perfectly
  //    and is missing its beginning.
  log("page_info =", JSON.stringify(full.page_info));
  log("context_truncation_continuation =", JSON.stringify(full.context_truncation_continuation));
  log("sectioned_conversation =", typeOf(full.sectioned_conversation));

  // 3. Does the count move when asked for more? If the default is a window,
  //    this is where it shows.
  for (const qs of ["?num_turns=1000", "?limit=1000", "?offset=0&limit=1000"]) {
    const r = await get(`/backend-api/conversations/${longest}${qs}`);
    log(`detail${qs} → status ${r.status}, ${(r.body?.messages ?? []).length} message(s)`);
  }

  // 4. What the extractor has to read or skip.
  const roles = {};
  const contentTypes = {};
  let hidden = 0;
  let timeType = null;
  for (const node of messages) {
    const m = node.message ?? node;
    roles[m.author?.role ?? m.role ?? "?"] = (roles[m.author?.role ?? m.role ?? "?"] ?? 0) + 1;
    const ct = m.content?.content_type ?? typeOf(m.content);
    contentTypes[ct] = (contentTypes[ct] ?? 0) + 1;
    if (m.metadata?.is_visually_hidden_from_conversation) hidden += 1;
    if (timeType === null && m.create_time != null) timeType = typeOf(m.create_time);
  }
  log("messages: roles =", roles);
  log("messages: content_types =", contentTypes);
  log("messages: hidden-from-conversation =", hidden);
  log("messages: create_time type =", timeType);

  // 5. Which key holds the visible text, per content_type — one sample each,
  //    reported by key name and length only.
  const seen = new Set();
  for (const node of messages) {
    const m = node.message ?? node;
    const ct = m.content?.content_type ?? "?";
    if (seen.has(ct)) continue;
    seen.add(ct);
    const c = m.content ?? {};
    const detail = Object.fromEntries(
      Object.keys(c).map((k) => [k, Array.isArray(c[k]) ? `array(${c[k].length})` : typeOf(c[k])]),
    );
    log(`content_type "${ct}" →`, JSON.stringify(detail));
  }
})();
