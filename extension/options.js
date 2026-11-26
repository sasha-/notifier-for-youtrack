import { DEFAULTS, getSettings, normalizeBaseUrl } from "./lib.js";

const $ = (id) => document.getElementById(id);
const status = (text, kind = "") => { const s = $("status"); s.textContent = text; s.className = kind; };

const HELP = {
  inbox: "Mirrors the bell: follows your YouTrack notification settings, subscriptions and muted threads. Marking read here also marks it read in YouTrack, and vice-versa. Uses YouTrack's internal notification API (not officially documented).",
  activity: "Watches activity on issues matching your query, using YouTrack's documented API. Ignores your YouTrack notification settings, and doesn't sync read state with the bell."
};
function updateSource() {
  const v = $("source").value;
  $("sourceHelp").textContent = HELP[v];
  $("activityOnly").style.display = v === "activity" ? "" : "none";
}
$("source").addEventListener("change", updateSource);

async function load() {
  const s = await getSettings();
  $("source").value = s.source;
  updateSource();
  $("baseUrl").value = s.baseUrl;
  $("token").value = s.token;
  $("query").value = s.query;
  $("pollMinutes").value = s.pollMinutes;
  $("includeFieldChanges").checked = s.includeFieldChanges;
  $("includeOwn").checked = s.includeOwn;
  $("sticky").checked = s.sticky;
  $("openMode").value = s.openMode;
}

async function save() {
  const baseUrl = normalizeBaseUrl($("baseUrl").value);
  if (!/^https?:\/\//i.test(baseUrl)) { status("Enter a full URL starting with https://", "err"); return false; }

  // Ask Chrome for permission to talk to this YouTrack host only.
  const origin = new URL(baseUrl).origin + "/*";
  const granted = await chrome.permissions.request({ origins: [origin] });
  if (!granted) { status("Permission to access " + origin + " was declined.", "err"); return false; }

  await chrome.storage.local.set({
    source: $("source").value,
    baseUrl,
    token: $("token").value.trim(),
    query: $("query").value.trim() || DEFAULTS.query,
    pollMinutes: Math.max(0.5, Number($("pollMinutes").value) || 1),
    includeFieldChanges: $("includeFieldChanges").checked,
    includeOwn: $("includeOwn").checked,
    sticky: $("sticky").checked,
    openMode: $("openMode").value
  });
  $("baseUrl").value = baseUrl;
  status("Saved.", "ok");
  return true;
}

$("save").addEventListener("click", save);

$("test").addEventListener("click", async () => {
  if (!(await save())) return;
  status("Testing…");
  const r = await chrome.runtime.sendMessage({ type: "test" });
  if (r.ok) {
    status(`Connected as ${r.me.fullName || r.me.login}. Connection OK. You'll get pop-ups for anything new from now on.`, "ok");
    chrome.runtime.sendMessage({ type: "checkNow" });
  } else {
    status("Failed: " + r.error, "err");
  }
});

$("testNotif").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "testNotification" });
  status("Sent a test notification. Nothing appeared? Check OS notification settings for Chrome (see README).");
});

load();
