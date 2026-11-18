// "Notification center" mode: mirrors YouTrack's own bell (the /api/inbox API the web UI uses).
// This API is undocumented; field names come from the YouTrack web app's own requests.

import { getSettings, getMe, setBadge, unreadCount, notifButtons } from "./lib.js";

const MAX_RECENT = 50;
const MAX_SEEN = 2000;
const MAX_POPUPS_PER_CHECK = 5;
const TOP = 50;

const MSG_FIELDS =
  "id,read,timestamp,threadId,text,reasons(id,name,type)," +
  "activities(id,$type,timestamp,category(id),author(login,fullName,name),field(id,presentation)," +
  "added(id,$type,login,fullName,name,text,idReadable,summary)," +
  "removed(id,$type,login,fullName,name,idReadable,summary),target(id,$type))";

const THREAD_FIELDS =
  `id,muted,notified,updated,messages(${MSG_FIELDS}),` +
  "subject(id,$type,target(id,$type,idReadable,summary,text,watchers(hasStar)," +
  "issue(id,idReadable,summary,watchers(hasStar))))";

// Used automatically if the detailed request is rejected (e.g. after a YouTrack update).
const THREAD_FIELDS_MIN =
  "id,muted,notified,updated,messages(id,read,timestamp,text,reasons(id,name,type))," +
  "subject(id,target(id,$type,idReadable,summary,issue(id,idReadable,summary)))";

async function getJson(settings, path, params) {
  const url = new URL(settings.baseUrl + path);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), {
    headers: { "Authorization": `Bearer ${settings.token}`, "Accept": "application/json" },
    cache: "no-store"
  });
  if (!res.ok) {
    let detail = "";
    try { const b = await res.json(); detail = b.error_description || b.error || ""; } catch { /* ignore */ }
    const err = new Error(`Notification center: HTTP ${res.status} ${detail}`.trim());
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function fetchThreads(settings, folder) {
  const params = { $top: TOP, reverse: "true", unreadOnly: "true", folder, fields: THREAD_FIELDS };
  try {
    return await getJson(settings, "/api/inbox/threads", params);
  } catch (e) {
    if (e.status === 400) {
      params.fields = THREAD_FIELDS_MIN;
      return getJson(settings, "/api/inbox/threads", params);
    }
    throw e;
  }
}

export async function testInbox() {
  const settings = await getSettings();
  const me = await getMe(settings);
  const threads = await fetchThreads(settings, undefined);
  return { me, sample: threads.length };
}

export async function markMessagesRead(messageIds, read = true) {
  if (!messageIds.length) return;
  const settings = await getSettings();
  const res = await fetch(`${settings.baseUrl}/api/inbox/markMessages?fields=read`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${settings.token}`,
      "Accept": "application/json",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ read: !!read, messages: messageIds.map(id => ({ id })) })
  });
  if (!res.ok) throw new Error(`Mark ${read ? "read" : "unread"} in YouTrack failed: HTTP ${res.status}`);
}

// ---------- formatting ----------

const who = (u) => (u && (u.fullName || u.name || u.login)) || "Someone";

function plain(text, n = 180) {
  if (!text) return "";
  const t = String(text).replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

function vals(v) {
  if (v == null) return "";
  if (typeof v !== "object") return String(v);
  return (Array.isArray(v) ? v : [v])
    .map(x => x && typeof x === "object" ? (x.fullName || x.name || x.login || x.idReadable || "") : String(x))
    .filter(Boolean).join(", ");
}

function subjectInfo(thread, baseUrl) {
  const t = (thread.subject && thread.subject.target) || {};
  const i = t.idReadable ? t : (t.issue && t.issue.idReadable ? t.issue : null);
  if (!i) return { title: "YouTrack", url: `${baseUrl}/`, issueDbId: null, issueId: null, starred: false };
  const isArticle = /Article/i.test(i.$type || t.$type || "");
  return {
    title: `${i.idReadable} ${i.summary || ""}`.trim(),
    url: `${baseUrl}/${isArticle ? "articles" : "issue"}/${i.idReadable}`,
    issueDbId: isArticle ? null : i.id,
    issueId: i.idReadable,
    starred: !!(i.watchers && i.watchers.hasStar)
  };
}

function describeActivity(a) {
  const author = who(a.author);
  const cat = (a.category && a.category.id) || "";
  const added = Array.isArray(a.added) ? a.added : (a.added != null ? [a.added] : []);
  if (/Comment/i.test(cat)) {
    const c = added[0];
    if (!c) return null;
    return { text: `${author} commented: ${plain(c.text)}`, commentId: c.id, commentText: c.text || "" };
  }
  if (/Reaction/i.test(cat)) return { text: `${author} reacted` };
  if (/IssueCreated/i.test(cat)) return { text: `${author} created this issue` };
  if (/CustomField/i.test(cat)) {
    const field = (a.field && a.field.presentation) || "a field";
    return { text: `${author} changed ${field}: ${vals(a.removed) || "—"} → ${vals(a.added) || "—"}`, addedUsers: added };
  }
  if (/Summary/i.test(cat)) return { text: `${author} renamed the issue` };
  if (/Description/i.test(cat)) return { text: `${author} updated the description` };
  if (/Attachment/i.test(cat)) return added.length ? { text: `${author} attached ${vals(added)}` } : null;
  if (/Link/i.test(cat)) return { text: `${author} updated links` };
  return { text: `${author} updated the issue` };
}

function describeThread(thread, unreadMsgs, folder, settings, me) {
  const subj = subjectInfo(thread, settings.baseUrl);
  const latest = unreadMsgs[unreadMsgs.length - 1];
  let d = null;
  outer: for (const m of unreadMsgs.slice().reverse()) {
    for (const a of (m.activities || []).slice().reverse()) { d = describeActivity(a); if (d) break outer; }
  }
  let message = d ? d.text : (plain(latest.text) || "New update");
  if (unreadMsgs.length > 1) message += `  (+${unreadMsgs.length - 1} more)`;

  const reasonsText = unreadMsgs.flatMap(m => m.reasons || []).map(r => `${r.name || ""} ${r.type || ""}`).join(" ");
  const mentionsMe = me && me.login && d && d.commentText && d.commentText.toLowerCase().includes("@" + me.login.toLowerCase());
  const assignedMe = me && d && d.addedUsers && d.addedUsers.some(u => u && u.login === me.login);
  const mention = folder === "direct" || /mention|reaction/i.test(reasonsText) || !!mentionsMe || !!assignedMe;

  let url = subj.url;
  if (d && d.commentId && subj.issueDbId) url += `#focus=Comments-${d.commentId}.0-0`;

  return {
    id: thread.id,                 // one popup-list item per bell thread
    source: "inbox",
    messageIds: unreadMsgs.map(m => m.id),
    timestamp: latest.timestamp || thread.updated || Date.now(),
    issueId: subj.issueId,
    issueDbId: subj.issueDbId,
    starred: subj.starred,
    title: `${mention ? "🔔 " : ""}${subj.title}`.slice(0, 120),
    message,
    mention,
    url,
    read: false
  };
}

// ---------- main check ----------

export async function checkInbox() {
  const settings = await getSettings();
  if (!settings.baseUrl || !settings.token) {
    await setBadge(0, "Not configured – open Options");
    return { ok: false, error: "Not configured" };
  }

  let { recent = [], seenMsgIds = [], inboxInitialized, me } =
    await chrome.storage.local.get(["recent", "seenMsgIds", "inboxInitialized", "me"]);

  try {
    if (!me) { me = await getMe(settings); await chrome.storage.local.set({ me }); }

    // Mentions & reactions tab, plus the default list. Merge by thread id.
    const [direct, other] = await Promise.all([
      fetchThreads(settings, "direct"),
      fetchThreads(settings, undefined)
    ]);
    const truncated = direct.length >= TOP || other.length >= TOP;
    const threads = new Map();
    for (const t of other) threads.set(t.id, { t, folder: "default" });
    for (const t of direct) threads.set(t.id, { t, folder: "direct" });

    const seen = new Set(seenMsgIds);
    const serverUnread = new Set();
    const fresh = [];      // items that get a popup
    const current = [];    // all unread items (for list/badge)

    for (const { t, folder } of threads.values()) {
      if (t.muted) continue;
      const unreadMsgs = (t.messages || []).filter(m => m && m.read !== true)
        .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
      if (!unreadMsgs.length) continue;
      unreadMsgs.forEach(m => serverUnread.add(m.id));
      const item = describeThread(t, unreadMsgs, folder, settings, me);
      current.push(item);
      const isNew = unreadMsgs.some(m => !seen.has(m.id));
      unreadMsgs.forEach(m => seen.add(m.id));
      if (isNew && inboxInitialized) fresh.push(item);
    }

    // Merge into the popup list: replace existing entries for the same thread.
    const currentIds = new Set(current.map(i => i.id));
    recent = recent.filter(r => !(r.source === "inbox" && currentIds.has(r.id)));
    recent = [...current.sort((a, b) => b.timestamp - a.timestamp), ...recent].slice(0, MAX_RECENT);

    // Read elsewhere (in YouTrack, phone, email)? Mark read here too and close popups.
    const { notifMap = {} } = await chrome.storage.session.get("notifMap");
    if (!truncated) {
      for (const r of recent) {
        if (r.source === "inbox" && r.read === false && !currentIds.has(r.id) &&
            !(r.messageIds || []).some(id => serverUnread.has(id))) {
          r.read = true;
        }
      }
      for (const [nid, info] of Object.entries(notifMap)) {
        if (info.source === "inbox" && info.itemId && !currentIds.has(info.itemId)) {
          chrome.notifications.clear(nid);
          delete notifMap[nid];
        }
      }
    }

    // Popups
    fresh.sort((x, y) => (y.mention - x.mention) || (x.timestamp - y.timestamp));
    const shown = fresh.slice(0, MAX_POPUPS_PER_CHECK);
    for (const n of shown) {
      // Close an older popup for the same thread before showing the update
      for (const [nid, info] of Object.entries(notifMap)) {
        if (info.itemId === n.id) { chrome.notifications.clear(nid); delete notifMap[nid]; }
      }
      const nid = `yt-${n.id}-${n.messageIds[n.messageIds.length - 1]}`;
      notifMap[nid] = { source: "inbox", url: n.url, itemId: n.id, issueDbId: n.issueDbId, issueId: n.issueId, starred: n.starred };
      chrome.notifications.create(nid, {
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: n.title,
        message: n.message,
        contextMessage: (n.starred ? "👁 Watching · " : "") + new Date(n.timestamp).toLocaleTimeString(),
        priority: n.mention ? 2 : 1,
        requireInteraction: !!settings.sticky || n.mention,
        buttons: n.issueDbId ? notifButtons(n.starred) : [{ title: "✓ Mark read" }]
      });
    }
    if (fresh.length > shown.length) {
      const nid = "yt-more-" + Date.now();
      notifMap[nid] = { source: "inbox", url: `${settings.baseUrl}/`, moreIds: fresh.slice(shown.length).map(n => n.id) };
      chrome.notifications.create(nid, {
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: "YouTrack",
        message: `…and ${fresh.length - shown.length} more. Click the extension icon to see them.`,
        priority: 1,
        requireInteraction: !!settings.sticky,
        buttons: [{ title: "✓ Mark these read" }]
      });
    }
    await chrome.storage.session.set({ notifMap });

    await chrome.storage.local.set({
      recent,
      seenMsgIds: Array.from(seen).slice(-MAX_SEEN),
      inboxInitialized: true,
      lastCheck: Date.now(),
      lastError: ""
    });
    await setBadge(unreadCount(recent));
    return { ok: true, count: fresh.length };
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    await chrome.storage.local.set({ lastCheck: Date.now(), lastError: msg });
    await setBadge(0, msg);
    return { ok: false, error: msg };
  }
}
