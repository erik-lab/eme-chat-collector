/**
 * ChatGPT endpoint probe. Paste into the devtools console on chatgpt.com.
 *
 * Writing an adapter against a guessed request shape cost a round trip on
 * Grok: `GET …/load-responses` returned 501, and the plausible alternative
 * would have returned 200 with zero items and looked like an empty account.
 * So the shapes get confirmed before any adapter is written.
 *
 * Prints STRUCTURE ONLY — key names, counts, types, roles. No message text,
 * no titles, no token value. Safe to paste back into a chat.
 */
(async () => {
  const log = (...a) => console.log("[probe]", ...a);
  const typeOf = (v) =>
    v === null ? "null" : Array.isArray(v) ? `array(${v.length})` : typeof v;

  // 1. Auth. Cookies alone return ZERO ITEMS rather than 401, so a collector
  //    built on them reports an empty account instead of "not signed in".
  //    This checks the token path exists before anything else is believed.
  let token = null;
  try {
    const session = await (await fetch("/api/auth/session", { credentials: "include" })).json();
    token = session.accessToken ?? null;
    log("auth: accessToken present =", Boolean(token), token ? `(length ${token.length})` : "");
    log("auth: session keys =", Object.keys(session));
  } catch (e) {
    log("auth: FAILED", e.message);
    return;
  }
  const auth = token ? { Authorization: `Bearer ${token}` } : {};

  const get = async (path) => {
    const r = await fetch(path, { credentials: "include", headers: auth });
    return { status: r.status, body: r.ok ? await r.json() : null };
  };

  // 2. The list. Shape, paging, and above all the TIMESTAMP FORMAT: Grok
  //    sends ISO strings, and the sync compares watermarks as text. If these
  //    are epoch numbers the adapter has to convert, or every comparison is
  //    wrong in a way that still looks like it works.
  const list = await get("/backend-api/conversations?limit=5&offset=0&order=updated");
  log("list: status", list.status, "keys =", list.body && Object.keys(list.body));
  const items = list.body?.items ?? list.body?.conversations ?? [];
  log("list: item count =", items.length, "total =", list.body?.total);
  if (items[0]) {
    log("list: item keys =", Object.keys(items[0]));
    for (const k of ["id", "create_time", "update_time"]) {
      log(`list: ${k} type = ${typeOf(items[0][k])} sample = ${JSON.stringify(items[0][k])}`);
    }
  }
  if (!items.length) {
    log("list: EMPTY — with a token this means no conversations; without one it means nothing");
    return;
  }

  // 3. The detail endpoint, and the question that matters most:
  //    does `num_turns` truncate? The UI sends num_turns=10, which fetches
  //    the tail rather than the conversation. Compare the same thread with
  //    and without it on the LONGEST conversation available.
  let longest = items[0].id;
  let best = -1;
  for (const item of items) {
    const r = await get(`/backend-api/conversations/${item.id}`);
    const n = Object.keys(r.body?.mapping ?? {}).length;
    if (n > best) {
      best = n;
      longest = item.id;
    }
  }
  log("detail: longest sampled conversation has", best, "mapping nodes");

  const full = await get(`/backend-api/conversations/${longest}`);
  const capped = await get(`/backend-api/conversations/${longest}?num_turns=10`);
  const nFull = Object.keys(full.body?.mapping ?? {}).length;
  const nCapped = Object.keys(capped.body?.mapping ?? {}).length;
  log("detail: nodes without num_turns =", nFull, " with num_turns=10 =", nCapped);
  log(
    "detail: num_turns",
    nCapped < nFull ? "TRUNCATES — must be omitted" : "appears to have no effect here",
  );

  // 4. The tree, and the content shapes to handle or skip.
  const body = full.body ?? {};
  log("detail: top-level keys =", Object.keys(body));
  log("detail: current_node present =", Boolean(body.current_node));

  const roles = {};
  const contentTypes = {};
  let hidden = 0;
  let nullMessage = 0;
  let timeType = null;
  for (const node of Object.values(body.mapping ?? {})) {
    const m = node.message;
    if (!m) {
      nullMessage += 1;
      continue;
    }
    roles[m.author?.role ?? "?"] = (roles[m.author?.role ?? "?"] ?? 0) + 1;
    const ct = m.content?.content_type ?? "?";
    contentTypes[ct] = (contentTypes[ct] ?? 0) + 1;
    if (m.metadata?.is_visually_hidden_from_conversation) hidden += 1;
    if (timeType === null && m.create_time != null) timeType = typeOf(m.create_time);
  }
  log("tree: author roles =", roles);
  log("tree: content_types =", contentTypes);
  log("tree: nodes with no message (the null root) =", nullMessage);
  log("tree: hidden-from-conversation messages =", hidden);
  log("tree: message create_time type =", timeType);

  // 5. Which keys a text message actually uses, so the extractor reads the
  //    right one per content_type rather than guessing.
  const sample = Object.values(body.mapping ?? {}).find((n) => n.message?.content);
  if (sample) {
    log("tree: message keys =", Object.keys(sample.message));
    log("tree: content keys =", Object.keys(sample.message.content));
    log("tree: node keys =", Object.keys(sample));
  }
})();
