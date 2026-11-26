// Core logic: settings, YouTrack API calls, turning activity into notifications.
import { markMessagesRead } from "./inbox.js";

export const DEFAULTS = {
  source: "inbox",             // "inbox" = mirror YouTrack's bell; "activity" = watch issues matching query
  baseUrl: "",                 // e.g. https://yourcompany.youtrack.cloud
  token: "",                   // permanent token: perm:xxxx
  query: "for: me or reporter: me or tag: Star or commenter: me",
  pollMinutes: 1,
  includeOwn: false,           // notify about your own changes?
  includeFieldChanges: true,   // state/assignee/priority etc.
  sticky: true,                // keep notifications on screen until dismissed
  openMode: "reuse"            // "reuse" = reuse an open YouTrack tab; "tab" = new tab in current window; "window" = new window
};

// Open a YouTrack link according to the user's "Open links in" setting.
export async function openUrl(url) {
  const { openMode, baseUrl } = await getSettings();

  const focusTab = async (tab) => {
    await chrome.windows.update(tab.windowId, { focused: true });
    return tab;
  };

  if (openMode === "window") {
    return chrome.windows.create({ url, focused: true });
  }

  if (openMode === "reuse" && baseUrl) {
    try {
      // Needs no extra permission: we already have host access to the YouTrack origin.
      const tabs = await chrome.tabs.query({ url: new URL(baseUrl).origin + "/*" });
      if (tabs.length) {
        let last;
        try { last = await chrome.windows.getLastFocused(); } catch { /* none */ }
        // Prefer a YouTrack tab in the window you used last, then the most recently used one.
        tabs.sort((a, b) =>
          ((b.windowId === last?.id) - (a.windowId === last?.id)) ||
          ((b.active ? 1 : 0) - (a.active ? 1 : 0)) ||
          ((b.lastAccessed || 0) - (a.lastAccessed || 0)));
        const tab = await chrome.tabs.update(tabs[0].id, { url, active: true });
        return focusTab(tab);
      }
    } catch (e) {
      console.warn("[YT Notifier] reuse tab failed, opening a new tab", e);
    }
  }

  // "tab" mode, or no YouTrack tab open: new tab in the last-used normal browser window.
  let win;
  try { win = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }); } catch { /* none */ }
  if (!win || win.type !== "normal") return chrome.windows.create({ url, focused: true });
  const tab = await chrome.tabs.create({ windowId: win.id, url, active: true });
  return focusTab(tab);
}

const OVERLAP_MS = 10 * 60 * 1000; // re-scan last 10 min to catch late-indexed activity
const MAX_SEEN = 1000;
const MAX_RECENT = 50;
const MAX_POPUPS_PER_CHECK = 5;

const ACTIVITY_FIELDS = [
  "id", "timestamp", "$type",
  "author(login,fullName,name)",
  "category(id)",
  "field(presentation,name)",
  "target(id,$type,idReadable,summary,text,watchers(hasStar),issue(id,idReadable,summary,watchers(hasStar)))",
  "added(id,$type,name,login,fullName,presentation,text,idReadable,summary)",
  "removed(id,$type,name,login,fullName,presentation,text)"
].join(",");

export async function getSettings() {
  const s = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...s };
}

export function normalizeBaseUrl(url) {
  url = (url || "").trim().replace(/\/+$/, "");
  // Strip common UI paths people paste by accident
  url = url.replace(/\/(dashboard|issues|agiles|projects|articles|issue\/.*)$/i, "");
  return url;
}

async function api(settings, path, params = {}) {
  const url = new URL(settings.baseUrl + path);
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach(x => url.searchParams.append(k, x));
    else if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString(), {
    headers: {
      "Authorization": `Bearer ${settings.token}`,
      "Accept": "application/json"
    },
    cache: "no-store"
  });
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = body.error_description || body.error || JSON.stringify(body);
    } catch { /* ignore */ }
    if (res.status === 401) throw new Error("401 Unauthorized – check the token.");
    if (res.status === 403) throw new Error("403 Forbidden – token lacks permission. " + detail);
    throw new Error(`HTTP ${res.status} ${detail}`.trim());
  }
  return res.json();
}

function categories(settings) {
  const c = [
    "CommentsCategory",
    "IssueCreatedCategory",
    "SummaryCategory",
    "DescriptionCategory",
    "AttachmentsCategory"
  ];
  if (settings.includeFieldChanges) c.push("CustomFieldCategory");
  return c.join(",");
}

export async function getMe(settings) {
  return api(settings, "/api/users/me", { fields: "id,login,fullName,name" });
}

export async function testConnection() {
  const settings = await getSettings();
  if (!settings.baseUrl || !settings.token) throw new Error("Enter the YouTrack URL and token first.");
  const me = await getMe(settings);
  const acts = await api(settings, "/api/activities", {
    fields: "id,timestamp",
    categories: categories(settings),
    issueQuery: settings.query,
    reverse: "true",
    $top: 1
  });
  return { me, sample: acts.length };
}

// ---------- formatting ----------

function who(u) {
  return (u && (u.fullName || u.name || u.login)) || "Someone";
}

function valuesText(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
  const arr = Array.isArray(v) ? v : [v];
  return arr.map(x => (typeof x === "object" && x)
    ? (x.presentation || x.fullName || x.name || x.login || x.idReadable || "")
    : String(x)).filter(Boolean).join(", ");
}

function snippet(text, n = 180) {
  if (!text) return "";
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

function catId(a) {
  return (a.category && a.category.id) || "";
}

function issueOf(a) {
  const t = a.target || {};
  const i = t.idReadable ? t : (t.issue && t.issue.idReadable ? t.issue : null);
  if (!i) return null;
  return {
    dbId: i.id,
    idReadable: i.idReadable,
    summary: i.summary,
    starred: !!(i.watchers && i.watchers.hasStar)
  };
}

export function describe(a, settings, me) {
  const issue = issueOf(a);
  if (!issue) return null;

  const author = who(a.author);
  const cat = catId(a);
  let message = "";
  let mention = false;
  let url = `${settings.baseUrl}/issue/${issue.idReadable}`;

  switch (cat) {
    case "CommentsCategory": {
      const added = Array.isArray(a.added) ? a.added : [];
      if (!added.length) return null; // comment deleted — skip
      const c = added[0];
      const text = c.text || (a.target && a.target.text) || "";
      message = `${author} commented: ${snippet(text)}`;
      if (me && me.login && text.toLowerCase().includes("@" + me.login.toLowerCase())) mention = true;
      if (c.id) url += `#focus=Comments-${c.id}.0-0`;
      break;
    }
    case "IssueCreatedCategory":
      message = `${author} created this issue`;
      break;
    case "CustomFieldCategory": {
      const field = (a.field && (a.field.presentation || a.field.name)) || "a field";
      const from = valuesText(a.removed);
      const to = valuesText(a.added);
      message = `${author} changed ${field}: ${from || "—"} → ${to || "—"}`;
      // Assigned to me?
      const addedArr = Array.isArray(a.added) ? a.added : [];
      if (me && addedArr.some(x => x && x.login === me.login)) mention = true;
      break;
    }
    case "SummaryCategory":
      message = `${author} renamed the issue`;
      break;
    case "DescriptionCategory":
      message = `${author} updated the description`;
      break;
    case "AttachmentsCategory": {
      const names = valuesText(a.added);
      if (!names) return null;
      message = `${author} attached ${names}`;
      break;
    }
    default:
      message = `${author} updated the issue`;
  }

  return {
    id: a.id,
    timestamp: a.timestamp,
    issueId: issue.idReadable,
    issueDbId: issue.dbId,
    starred: issue.starred,
    read: false,
    title: `${mention ? "🔔 " : ""}${issue.idReadable} ${issue.summary || ""}`.slice(0, 120),
    message,
    author,
    mention,
    url
  };
}

// ---------- badge ----------

export async function setBadge(count, error) {
  if (error) {
    await chrome.action.setBadgeBackgroundColor({ color: "#d93025" });
    await chrome.action.setBadgeText({ text: "!" });
    await chrome.action.setTitle({ title: "Notifier for YouTrack – " + error });
    return;
  }
  await chrome.action.setBadgeBackgroundColor({ color: "#1a73e8" });
  await chrome.action.setBadgeText({ text: count > 0 ? (count > 99 ? "99+" : String(count)) : "" });
  await chrome.action.setTitle({ title: "Notifier for YouTrack" });
}

export function unreadCount(recent) {
  return (recent || []).filter(n => n.read === false).length;
}

export async function refreshBadge() {
  const { recent = [], lastError } = await chrome.storage.local.get(["recent", "lastError"]);
  await setBadge(unreadCount(recent), lastError || "");
}

// ---------- read / star actions ----------

// ids: array of item ids, or "all". read = true to mark read, false to mark unread.
export async function markRead(ids, read = true) {
  const { recent = [] } = await chrome.storage.local.get("recent");
  const set = ids === "all" ? null : new Set(ids);
  const serverMsgIds = [];
  for (const n of recent) {
    if (set && !set.has(n.id)) continue;
    const isRead = n.read !== false;
    if (isRead === read) continue;                       // already in that state
    if (n.source === "inbox") serverMsgIds.push(...(n.messageIds || []));
    n.read = read;
  }
  await chrome.storage.local.set({ recent });
  // Notification-center items: do the same in YouTrack so the bell matches.
  if (serverMsgIds.length) {
    try {
      await markMessagesRead(serverMsgIds, read);
    } catch (e) {
      await chrome.storage.local.set({ lastError: e.message || String(e) });
    }
  }
  // Marking read closes any matching on-screen notifications
  if (read) {
    const { notifMap = {} } = await chrome.storage.session.get("notifMap");
    for (const [nid, info] of Object.entries(notifMap)) {
      if (!set || (info.itemId && set.has(info.itemId))) {
        chrome.notifications.clear(nid);
        delete notifMap[nid];
      }
    }
    await chrome.storage.session.set({ notifMap });
  }
  await refreshBadge();
}

// star = true to star, false to unstar.
export async function setStar(issueDbId, star) {
  // Same call YouTrack's own web UI makes when you click the star.
  const settings = await getSettings();
  const headers = {
    "Authorization": `Bearer ${settings.token}`,
    "Accept": "application/json",
    "Content-Type": "application/json"
  };
  const want = !!star;
  const problems = [];

  // 1) Same call YouTrack's web UI makes. Check the server actually changed it.
  try {
    const url = `${settings.baseUrl}/api/issues/${encodeURIComponent(issueDbId)}/watchers?fields=hasStar`;
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ hasStar: want }) });
    const body = await res.json().catch(() => ({}));
    console.log("[YT Notifier] star via watchers", { issueDbId, want, status: res.status, body });
    if (!res.ok) problems.push(`watchers: HTTP ${res.status} ${body.error_description || body.error || ""}`.trim());
    else if (body.hasStar === want) return finishStar(issueDbId, want);
    else problems.push(`watchers: accepted but hasStar is still ${body.hasStar}`);
  } catch (e) {
    problems.push("watchers: " + (e.message || e));
  }

  // 2) Fallback: YouTrack command "star <login>" / "unstar <login>".
  try {
    let { me } = await chrome.storage.local.get("me");
    if (!me) { me = await getMe(settings); await chrome.storage.local.set({ me }); }
    const res = await fetch(`${settings.baseUrl}/api/commands`, {
      method: "POST", headers,
      body: JSON.stringify({ query: `${want ? "star" : "unstar"} ${me.login}`, issues: [{ id: issueDbId }] })
    });
    const body = await res.json().catch(() => ({}));
    console.log("[YT Notifier] star via command", { issueDbId, want, status: res.status, body });
    if (res.ok) {
      // Verify
      const chk = await fetch(`${settings.baseUrl}/api/issues/${encodeURIComponent(issueDbId)}/watchers?fields=hasStar`, { headers });
      const cb = await chk.json().catch(() => ({}));
      if (cb.hasStar === want) return finishStar(issueDbId, want);
      problems.push(`command: accepted but hasStar is ${cb.hasStar}`);
    } else {
      problems.push(`command: HTTP ${res.status} ${body.error_description || body.error || ""}`.trim());
    }
  } catch (e) {
    problems.push("command: " + (e.message || e));
  }

  const msg = `Star failed for ${issueDbId} – ${problems.join("; ")}`;
  await chrome.storage.local.set({ lastError: msg });
  throw new Error(msg);
}

async function finishStar(issueDbId, star) {
  // Update every stored item for this issue
  const { recent = [] } = await chrome.storage.local.get("recent");
  for (const n of recent) if (n.issueDbId === issueDbId) n.starred = star;
  await chrome.storage.local.set({ recent });
  return star;
}

export function notifButtons(starred) {
  return [{ title: "✓ Mark read" }, { title: starred ? "Stop watching" : "👁 Watch" }];
}

// ---------- main check ----------

export async function checkNow() {
  const settings = await getSettings();
  if (!settings.baseUrl || !settings.token) {
    await setBadge(0, "Not configured – open Options");
    return { ok: false, error: "Not configured" };
  }

  const state = await chrome.storage.local.get(["lastTimestamp", "seenIds", "recent", "me"]);
  let { lastTimestamp, seenIds = [], recent = [], me } = state;

  try {
    if (!me) {
      me = await getMe(settings);
      await chrome.storage.local.set({ me });
    }

    // First run: start from now so we don't flood you with history.
    if (!lastTimestamp) {
      await chrome.storage.local.set({ lastTimestamp: Date.now(), seenIds: [], lastCheck: Date.now(), lastError: "" });
      await setBadge(unreadCount(recent));
      return { ok: true, initialized: true, count: 0 };
    }

    const activities = await api(settings, "/api/activities", {
      fields: ACTIVITY_FIELDS,
      categories: categories(settings),
      issueQuery: settings.query,
      start: String(lastTimestamp - OVERLAP_MS),
      reverse: "false",
      $top: 200
    });

    const seen = new Set(seenIds);
    const fresh = [];
    let maxTs = lastTimestamp;

    for (const a of activities) {
      if (!a || !a.id || seen.has(a.id)) continue;
      seen.add(a.id);
      if (a.timestamp > maxTs) maxTs = a.timestamp;
      if (!settings.includeOwn && me && a.author && a.author.login === me.login) continue;
      const d = describe(a, settings, me);
      if (d) fresh.push(d);
    }

    // Show notifications (mentions first, cap the number of popups)
    fresh.sort((x, y) => (y.mention - x.mention) || (x.timestamp - y.timestamp));
    const shown = fresh.slice(0, MAX_POPUPS_PER_CHECK);
    const notifMap = (await chrome.storage.session.get("notifMap")).notifMap || {};

    for (const n of shown) {
      const nid = "yt-" + n.id;
      notifMap[nid] = { url: n.url, itemId: n.id, issueDbId: n.issueDbId, issueId: n.issueId, starred: n.starred };
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
      notifMap[nid] = {
        url: `${settings.baseUrl}/issues?q=${encodeURIComponent(settings.query)}`,
        moreIds: fresh.slice(shown.length).map(n => n.id)
      };
      chrome.notifications.create(nid, {
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: "YouTrack",
        message: `…and ${fresh.length - shown.length} more updates. Click the extension icon to see them.`,
        priority: 1,
        requireInteraction: !!settings.sticky,
        buttons: [{ title: "✓ Mark these read" }]
      });
    }
    await chrome.storage.session.set({ notifMap });

    recent = [...fresh.slice().reverse(), ...recent].slice(0, MAX_RECENT);

    await chrome.storage.local.set({
      lastTimestamp: maxTs,
      seenIds: Array.from(seen).slice(-MAX_SEEN),
      recent,
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
