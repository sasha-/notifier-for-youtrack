import { getSettings, checkNow as checkActivity, testConnection, markRead, setStar, notifButtons, refreshBadge, openUrl } from "./lib.js";
import { checkInbox, testInbox } from "./inbox.js";

async function checkNow() {
  const { source } = await getSettings();
  return source === "activity" ? checkActivity() : checkInbox();
}

async function testNow() {
  const { source, baseUrl, token } = await getSettings();
  if (!baseUrl || !token) throw new Error("Enter the YouTrack URL and token first.");
  return source === "activity" ? testConnection() : testInbox();
}

const ALARM = "youtrack-poll";

// Numeric version compare: "1.10.0" > "1.3".
function versionLess(a, b) {
  const pa = String(a).split(".").map(Number), pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x < y;
  }
  return false;
}

async function scheduleAlarm() {
  const { pollMinutes } = await getSettings();
  const period = Math.max(0.5, Number(pollMinutes) || 1);
  await chrome.alarms.clear(ALARM);
  chrome.alarms.create(ALARM, { periodInMinutes: period, delayInMinutes: 0.1 });
}

async function getNotifMap() {
  return (await chrome.storage.session.get("notifMap")).notifMap || {};
}

chrome.runtime.onInstalled.addListener(async (details) => {
  await scheduleAlarm();
  // Migrate from v1.0 (single unread counter → per-item read flags)
  await chrome.storage.local.remove("unread");
  // v1.3: default source switched to the notification center – start the list fresh.
  if (details.reason === "update" && details.previousVersion && versionLess(details.previousVersion, "1.3")) {
    await chrome.storage.local.set({ recent: [] });
  }
  await refreshBadge();
  const { token, baseUrl } = await getSettings();
  if (details.reason === "install" || !token || !baseUrl) chrome.runtime.openOptionsPage();
});

chrome.runtime.onStartup.addListener(async () => {
  await scheduleAlarm();
  await refreshBadge();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) checkNow();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.pollMinutes) scheduleAlarm();
  // Changing instance, token or query: reset tracking so we start fresh from "now".
  if (changes.baseUrl || changes.token || changes.query || changes.source) {
    chrome.storage.local.remove(["lastTimestamp", "seenIds", "me", "seenMsgIds", "inboxInitialized"]);
  }
  // Switching source or instance: clear the old list so items from the other mode don't linger.
  if (changes.baseUrl || changes.source) chrome.storage.local.set({ recent: [] }).then(refreshBadge);
});

// Clicking the notification body: open the issue and mark it read.
chrome.notifications.onClicked.addListener(async (nid) => {
  const map = await getNotifMap();
  const info = map[nid];
  if (info && info.url) await openUrl(info.url);
  if (info && info.itemId) await markRead([info.itemId]);
  else if (info && info.moreIds) await markRead(info.moreIds);
  chrome.notifications.clear(nid);
});

// Buttons: 0 = Mark read, 1 = Watch/Stop watching (YouTrack "Star")
chrome.notifications.onButtonClicked.addListener(async (nid, index) => {
  const map = await getNotifMap();
  const info = map[nid];
  if (!info) return;

  if (index === 0) {
    if (info.itemId) await markRead([info.itemId]);
    else if (info.moreIds) await markRead(info.moreIds);
    chrome.notifications.clear(nid);
    return;
  }

  if (index === 1 && info.issueDbId) {
    try {
      const nowStarred = await setStar(info.issueDbId, !info.starred);
      info.starred = nowStarred;
      map[nid] = info;
      await chrome.storage.session.set({ notifMap: map });
      chrome.notifications.update(nid, {
        buttons: notifButtons(nowStarred),
        contextMessage: nowStarred ? `👁 Now watching ${info.issueId} – you'll get its updates` : `Stopped watching ${info.issueId}`
      });
    } catch (e) {
      chrome.notifications.update(nid, { contextMessage: "⚠ " + (e.message || e) });
    }
  }
});

chrome.notifications.onClosed.addListener(async (nid) => {
  const map = await getNotifMap();
  if (map[nid]) {
    delete map[nid];
    await chrome.storage.session.set({ notifMap: map });
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "checkNow") return sendResponse(await checkNow());
      if (msg.type === "openUrl") { await openUrl(msg.url); return sendResponse({ ok: true }); }
      if (msg.type === "test") return sendResponse({ ok: true, ...(await testNow()) });
      if (msg.type === "markRead") { await markRead(msg.ids || "all", msg.read !== false); return sendResponse({ ok: true }); }
      if (msg.type === "setStar") { const s = await setStar(msg.issueDbId, msg.star); return sendResponse({ ok: true, starred: s }); }
      if (msg.type === "testNotification") {
        chrome.notifications.create("yt-test-" + Date.now(), {
          type: "basic",
          iconUrl: "icons/icon128.png",
          title: "Notifier for YouTrack",
          message: "Test notification – if you can see this, notifications work.",
          priority: 2,
          buttons: [{ title: "✓ Mark read" }, { title: "👁 Watch" }]
        });
        return sendResponse({ ok: true });
      }
      sendResponse({ ok: false, error: "Unknown message" });
    } catch (e) {
      sendResponse({ ok: false, error: e.message || String(e) });
    }
  })();
  return true;
});
