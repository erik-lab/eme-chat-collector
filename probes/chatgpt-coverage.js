/**
 * ChatGPT COVERAGE probe — is the default list your whole history?
 *
 * Paste into the devtools console on chatgpt.com. Prints counts, ids and
 * status codes only: no titles, no project names, no message text, no token.
 *
 * Round 1 found two things and misled on a third.
 *
 *   - Paging the default list yields 761 conversations on an account whose
 *     `total` field claimed 101, and claimed 21 in an earlier run. `total`
 *     is not the account total and cannot be read as one; pages are walked
 *     until a short one.
 *   - `/backend-api/gizmos/bootstrap` → {gizmos} and
 *     `/backend-api/gizmos/snorlax/sidebar` → {items, cursor} both answer.
 *     "snorlax" appears to be the internal name for projects. Both are
 *     undocumented and may be renamed without notice.
 *   - The archived question was NOT answered. That round compared `total`
 *     values, which is the field already known to lie. Counting the items
 *     actually returned is the only honest measure, and is what round 2
 *     does.
 *
 * BEFORE RUNNING: open a conversation that lives inside a PROJECT and paste
 * its whole address below. A project conversation's URL looks like
 *
 *   chatgpt.com/g/g-p-<projectId>-<slug>/c/<conversationId>
 *
 * so it carries both ids, and the slug is the project's name — which is why
 * nothing from it is committed to this repo or printed in full below.
 */
const PROJECT_CONVERSATION_URL = "";  // ← paste the whole URL

(async () => {
  const log = (...a) => console.log("[probe]", ...a);
  const session = await (await fetch("/api/auth/session", { credentials: "include" })).json();
  if (!session.accessToken) return log("auth: NO TOKEN — stop");
  const auth = { Authorization: `Bearer ${session.accessToken}` };
  const get = async (path) => {
    const r = await fetch(path, { credentials: "include", headers: auth });
    return { status: r.status, body: r.ok ? await r.json().catch(() => null) : null };
  };

  /** Walk a conversations listing to exhaustion. Returns the ids actually given. */
  const pageAll = async (base) => {
    const ids = new Set();
    for (let page = 0; page < 50; page += 1) {
      const r = await get(`${base}&limit=100&offset=${page * 100}`);
      const items = r.body?.items ?? [];
      items.forEach((i) => ids.add(i.id));
      if (items.length < 100) break;
    }
    return ids;
  };

  const base = await pageAll("/backend-api/conversations?order=updated");
  log(`default list: ${base.size} conversation(s) actually returned`);

  // 1. Archived, measured by ITEMS rather than by `total`.
  for (const qs of ["is_archived=true", "is_archived=false"]) {
    const ids = await pageAll(`/backend-api/conversations?order=updated&${qs}`);
    const extra = [...ids].filter((id) => !base.has(id));
    log(`  ?${qs} → ${ids.size} item(s), ${extra.length} of them NOT in the default list`);
  }

  // 2. Projects. What `gizmos` and the sidebar actually contain — shapes and
  //    counts only, never names.
  const boot = await get("/backend-api/gizmos/bootstrap");
  const gizmos = boot.body?.gizmos ?? [];
  log(`gizmos/bootstrap: ${Array.isArray(gizmos) ? gizmos.length : "?"} entr(ies)`);
  if (Array.isArray(gizmos) && gizmos[0]) {
    log("  entry keys =", Object.keys(gizmos[0]));
  }

  const sidebar = await get("/backend-api/gizmos/snorlax/sidebar");
  const items = sidebar.body?.items ?? [];
  log(`snorlax/sidebar: ${items.length} item(s), cursor=${JSON.stringify(sidebar.body?.cursor)}`);
  if (items[0]) {
    log("  item keys =", Object.keys(items[0]));
    const inner = items[0].gizmo ?? items[0];
    log("  inner keys =", Object.keys(inner));
    // The id shape decides what to ask for next: a project id looks like
    // g-p-… while a conversation id is a uuid.
    log("  first id =", JSON.stringify(inner.id ?? items[0].id));
  }

  // 3. A project's conversations. The sidebar request the UI makes carries
  //    `conversations_per_gizmo=0`, which reads like "give me the projects
  //    but none of their chats" — so asking for some is the obvious next
  //    question, and the cheapest.
  const withChats = await get(
    "/backend-api/gizmos/snorlax/sidebar?conversations_per_gizmo=10&limit=50&owned_only=false",
  );
  const withChatsItems = withChats.body?.items ?? [];
  log(`sidebar?conversations_per_gizmo=10 → ${withChats.status}, ${withChatsItems.length} item(s)`);
  if (withChatsItems[0]) {
    log("  item keys =", Object.keys(withChatsItems[0]));
    const convs =
      withChatsItems[0].conversations ?? withChatsItems[0].conversation_ids ?? null;
    log("  conversations present =", Array.isArray(convs) ? `array(${convs.length})` : "no");
    if (Array.isArray(convs) && convs[0]) {
      log("  conversation entry keys =", Object.keys(convs[0]));
    }
  }

  // Still worth trying the per-project paths, in case the sidebar only ever
  // summarises. 404s cost nothing.
  const projectId = (items[0]?.gizmo ?? items[0] ?? {}).id;
  if (projectId) {
    for (const path of [
      `/backend-api/gizmos/${projectId}/conversations?limit=10`,
      `/backend-api/conversations?order=updated&limit=10&gizmo_id=${projectId}`,
    ]) {
      const r = await get(path);
      log(`  GET ${path.split("?")[0]} → ${r.status}, ${(r.body?.items ?? []).length} item(s)`);
    }
  }

  // 4. The decisive test, and the whole reason for this probe.
  if (!PROJECT_CONVERSATION_URL) {
    return log("project check: SKIPPED — paste a project conversation URL at the top");
  }
  const match = PROJECT_CONVERSATION_URL.match(/\/g\/(g-p-[0-9a-f]+)[^/]*\/c\/([0-9a-f-]{36})/);
  if (!match) return log("project check: could not read that URL — expected .../g/g-p-…/c/<uuid>");
  const [, projectFromUrl, conversationId] = match;

  log("project check: in the default list =", base.has(conversationId));
  const one = await get(`/backend-api/conversations/${conversationId}`);
  log(
    "project check: direct fetch →",
    one.status,
    `${(one.body?.messages ?? []).length} message(s)`,
    `gizmo_id matches the URL =`,
    one.body?.gizmo_id === projectFromUrl,
    `conversation_origin=${JSON.stringify(one.body?.conversation_origin)}`,
  );
  log("   → in the list: nothing to do.");
  log("     absent but fetchable: a wider list step, same adapter.");
  log("     not fetchable: a real adapter change.");
})();
