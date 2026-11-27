/**
 * ChatGPT COVERAGE probe — is the default list your whole history?
 *
 * Paste into the devtools console on chatgpt.com. Prints counts, ids and
 * status codes only: no titles, no message text, no token value.
 *
 * Why: the list reported `total: 21` for an account with many more
 * conversations, so `/backend-api/conversations` is filtered. The item shape
 * suggests by what — `is_archived`, `gizmo_id`, `workspace_id`,
 * `conversation_origin` are all per-item fields.
 *
 * This matters more than it sounds. A collector that syncs a filtered list
 * reports success, shows a plausible number of conversations, and silently
 * omits whatever the filter excluded. Nobody notices, because there is
 * nothing to notice.
 *
 * BEFORE RUNNING: open a conversation that lives inside a PROJECT, copy the
 * id out of the address bar (chatgpt.com/c/<id>), and paste it below.
 */
const PROJECT_CONVERSATION_ID = "";   // ← paste one, or leave empty to skip

(async () => {
  const log = (...a) => console.log("[probe]", ...a);

  const session = await (await fetch("/api/auth/session", { credentials: "include" })).json();
  if (!session.accessToken) return log("auth: NO TOKEN — stop");
  const auth = { Authorization: `Bearer ${session.accessToken}` };
  const get = async (path) => {
    const r = await fetch(path, { credentials: "include", headers: auth });
    return { status: r.status, body: r.ok ? await r.json().catch(() => null) : null };
  };

  // 1. The default list, paged to exhaustion. `total` is what the server
  //    claims; the count is what it actually hands over.
  const seen = new Set();
  let total = null;
  for (let page = 0; page < 50; page += 1) {
    const r = await get(`/backend-api/conversations?limit=100&offset=${page * 100}&order=updated`);
    const items = r.body?.items ?? [];
    total ??= r.body?.total;
    items.forEach((i) => seen.add(i.id));
    if (items.length < 100) break;
  }
  log(`default list: server says total=${total}, paged ${seen.size} distinct id(s)`);
  log("   → if that is far fewer than you have, the list is filtered");

  // 2. Which filter? Each of these is a guess at a parameter name; a 200
  //    with a DIFFERENT total is the interesting result, a 422 just means
  //    the parameter does not exist.
  for (const qs of [
    "is_archived=true",
    "is_archived=false",
    "include_archived=true",
    "is_starred=true",
    "conversation_origin=null",
  ]) {
    const r = await get(`/backend-api/conversations?limit=1&offset=0&order=updated&${qs}`);
    log(`  ?${qs} → ${r.status}, total=${r.body?.total ?? "-"}`);
  }

  // 3. Projects. These are guesses at where a project's conversations are
  //    listed; status codes alone say which exist. If none answer, capture
  //    it from the network tab instead: open a project in the UI with
  //    devtools recording and look for the request that lists its chats.
  for (const path of [
    "/backend-api/gizmos/bootstrap",
    "/backend-api/gizmos/snorlax/sidebar",
    "/backend-api/projects",
    "/backend-api/workspaces",
    "/backend-api/conversations?limit=1&offset=0&order=updated&gizmo_id=null",
  ]) {
    const r = await get(path);
    const keys = r.body && typeof r.body === "object" ? Object.keys(r.body).slice(0, 8) : null;
    log(`  GET ${path} → ${r.status}`, keys ? `keys=${JSON.stringify(keys)}` : "");
  }

  // 4. The decisive test. Is a known project conversation in the list the
  //    collector walks, and if not, can it still be fetched directly? That
  //    second answer decides whether this is an adapter change or only a
  //    wider list step.
  if (!PROJECT_CONVERSATION_ID) {
    return log("project check: skipped — paste a project conversation id at the top");
  }
  log("project check: id is in the default list =", seen.has(PROJECT_CONVERSATION_ID));
  const one = await get(`/backend-api/conversations/${PROJECT_CONVERSATION_ID}`);
  log(
    "project check: direct fetch →",
    one.status,
    `${(one.body?.messages ?? []).length} message(s)`,
    `gizmo_id=${JSON.stringify(one.body?.gizmo_id)}`,
    `workspace_id=${JSON.stringify(one.body?.workspace_id)}`,
    `conversation_origin=${JSON.stringify(one.body?.conversation_origin)}`,
  );
})();
