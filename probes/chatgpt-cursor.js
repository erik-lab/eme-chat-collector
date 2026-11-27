/**
 * ChatGPT MESSAGE-CURSOR probe — how do you fetch a conversation's earlier
 * messages?
 *
 * Paste into the devtools console on chatgpt.com.
 *
 * A conversation whose `page_info.has_previous_page` is true has messages
 * behind a cursor, and the adapter refuses to store it rather than keep half
 * a transcript. This finds the request that gets the rest.
 *
 * Done here instead of in the network tab because that page fires many
 * cursor-bearing requests — the projects sidebar and a `spaces/v2` listing
 * among them — and picking the right one by eye has already failed twice.
 * This one tries parameter shapes against a conversation known to be paged
 * and reports which actually returns EARLIER messages.
 *
 * PRIVACY: cursor values are base64 JSON and some of them contain your
 * OpenAI account id. They are never printed. Nor are titles or message text.
 */
const CONVERSATION_ID = "fe64741e-8e80-49ee-9edc-082fd36c8352"; // or "" to search for one

(async () => {
  const log = (...a) => console.log("[probe]", ...a);
  const session = await (await fetch("/api/auth/session", { credentials: "include" })).json();
  if (!session.accessToken) return log("auth: NO TOKEN — stop");
  const auth = { Authorization: `Bearer ${session.accessToken}` };
  const get = async (path) => {
    const r = await fetch(path, { credentials: "include", headers: auth });
    return { status: r.status, body: r.ok ? await r.json().catch(() => null) : null };
  };

  // 1. A conversation that is actually paged. Given one, check it; given
  //    none, hunt for one, because only a long conversation shows this.
  let id = CONVERSATION_ID;
  let first = id ? (await get(`/backend-api/conversations/${id}`)).body : null;
  if (!first?.page_info?.has_previous_page) {
    if (id) log(`${id.slice(0, 8)} is not paged (has_previous_page is false) — searching…`);
    const list = await get("/backend-api/conversations?limit=100&offset=0&order=updated");
    for (const item of list.body?.items ?? []) {
      const body = (await get(`/backend-api/conversations/${item.id}`)).body;
      if (body?.page_info?.has_previous_page) {
        id = item.id;
        first = body;
        break;
      }
    }
  }
  if (!first?.page_info?.has_previous_page) {
    return log("no paged conversation found in the newest 100 — try an older one by id");
  }

  const firstIds = (first.messages ?? []).map((m) => m.id);
  const cursor = first.page_info.start_cursor;
  log(`paged conversation ${id.slice(0, 8)}: ${firstIds.length} message(s) in the first page`);
  log("page_info flags =", {
    has_previous_page: first.page_info.has_previous_page,
    has_next_page: first.page_info.has_next_page,
  });

  // 2. Parameter shapes. The answer is a 200 whose message ids are NOT the
  //    ones already seen — a 200 returning the same page is the dangerous
  //    result, because a collector would loop on it forever believing it was
  //    making progress.
  const encoded = encodeURIComponent(cursor);
  const candidates = [
    `cursor=${encoded}`,
    `before=${encoded}`,
    `start_cursor=${encoded}`,
    `after=${encoded}`,
    `cursor=${encoded}&direction=previous`,
    `cursor=${encoded}&direction=backward`,
    `cursor=${encoded}&limit=100`,
    `before=${encoded}&limit=100`,
  ];

  for (const qs of candidates) {
    const r = await get(`/backend-api/conversations/${id}?${qs}`);
    const ids = (r.body?.messages ?? []).map((m) => m.id);
    const fresh = ids.filter((m) => !firstIds.includes(m)).length;
    const label = qs.replace(/=[^&]*/g, "=…");
    log(
      `  ?${label} → ${r.status}, ${ids.length} message(s), ${fresh} not seen before`,
      r.body?.page_info
        ? `has_previous=${r.body.page_info.has_previous_page}`
        : "",
    );
  }

  log("");
  log("WANTED: a 200 with messages 'not seen before' greater than zero.");
  log("A 200 with zero new ones is the trap — it looks like it worked and");
  log("a collector paging on it would loop forever thinking it progressed.");
})();
