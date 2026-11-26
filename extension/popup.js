const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);

function ago(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return Math.round(s / 60) + " min ago";
  if (s < 86400) return Math.round(s / 3600) + " h ago";
  return new Date(ts).toLocaleDateString();
}

async function render() {
  const { recent = [], lastCheck, lastError, baseUrl } =
    await chrome.storage.local.get(["recent", "lastCheck", "lastError", "baseUrl"]);

  const meta = $("meta");
  const unread = recent.filter(n => n.read === false).length;
  if (!baseUrl) {
    meta.textContent = "Not set up yet – click ⚙ to configure.";
    meta.className = "err";
  } else if (lastError) {
    meta.textContent = "Error: " + lastError;
    meta.className = "err";
  } else {
    meta.textContent = (lastCheck ? "Last checked " + ago(lastCheck) : "Waiting for first check…") +
      (unread ? ` · ${unread} unread` : "");
    meta.className = "";
  }
  $("allRead").disabled = unread === 0;

  const list = $("list");
  list.innerHTML = "";
  if (!recent.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No new activity yet.";
    list.appendChild(li);
    return;
  }

  for (const n of recent) {
    const li = document.createElement("li");
    if (n.mention) li.classList.add("mention");
    if (n.read === false) li.classList.add("unread");

    const a = document.createElement("a");
    a.href = n.url;
    a.addEventListener("click", async (e) => {
      e.preventDefault();
      // Let the background open it so the "Open links in" setting applies; then close the popup.
      await send({ type: "markRead", ids: [n.id] });
      await send({ type: "openUrl", url: n.url });
      window.close();
    });
    const t = document.createElement("div"); t.className = "title"; t.textContent = n.title;
    const m = document.createElement("div"); m.className = "msg"; m.textContent = n.message;
    const w = document.createElement("div"); w.className = "when"; w.textContent = ago(n.timestamp);
    a.append(t, m, w);

    const actions = document.createElement("div");
    actions.className = "actions";

    if (n.issueDbId) {
      const star = document.createElement("button");
      star.className = "icon" + (n.starred ? " on" : "");
      star.textContent = "👁";
      star.title = n.starred ? "Watching – click to stop watching" : "Watch this issue (get its updates)";
      star.addEventListener("click", async () => {
        star.disabled = true;
        const r = await send({ type: "setStar", issueDbId: n.issueDbId, star: !n.starred });
        if (!r.ok) { $("meta").textContent = r.error; $("meta").className = "err"; }
        render();
      });
      actions.appendChild(star);
    }

    const unread = n.read === false;
    const rd = document.createElement("button");
    rd.className = "icon" + (unread ? "" : " read");
    rd.textContent = unread ? "●" : "✓";
    rd.title = unread ? "Unread – click to mark read" : "Read – click to mark unread";
    rd.addEventListener("click", async () => {
      rd.disabled = true;
      await send({ type: "markRead", ids: [n.id], read: unread });
      render();
    });
    actions.appendChild(rd);

    li.append(a, actions);
    list.appendChild(li);
  }
}

$("allRead").addEventListener("click", async () => { await send({ type: "markRead", ids: "all" }); render(); });
$("check").addEventListener("click", async () => {
  $("meta").textContent = "Checking…";
  await send({ type: "checkNow" });
  render();
});
$("opts").addEventListener("click", () => chrome.runtime.openOptionsPage());

render();
