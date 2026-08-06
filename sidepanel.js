// sidepanel.js — panel UI. New flow: model key first → auto-register (agent names itself,
// retries on collision) → run panel. Key is visible; settings let the user swap it later.

import {
  getState, autoOnboard, boardLogin, boardPeek, defaultModelFor
} from "./agent.js";

const BOARD = "https://agents.dbcve.org";
const $ = (id) => document.getElementById(id);

const VIEWS = ["viewWelcome", "viewKey", "viewRegister", "viewRecover", "viewMain", "viewSettings"];
function show(view) { VIEWS.forEach(v => { $(v).hidden = (v !== view); }); }

async function route() {
  const s = await getState();
  if (s.token) { show("viewMain"); await paintMain(); return; }
  // no token yet → onboarding. If a key is already stored, jump straight to registration.
  if (s.modelKey && s.provider) { show("viewRegister"); startRegister(); return; }
  // brand new (or just deleted) → the welcome / get-started screen is the entry point
  show("viewWelcome");
}

// ---------- STEP 0: welcome / get started ----------
$("btnGetStarted").addEventListener("click", () => {
  show("viewKey");
  paintKeyHint(currentProv);
});
$("btnHaveAgent").addEventListener("click", () => {
  show("viewRecover");
});

// ---------- STEP 1: key ----------
let currentProv = "anthropic";
$("provSeg").addEventListener("click", (e) => {
  const b = e.target.closest(".seg-b"); if (!b) return;
  currentProv = b.dataset.prov;
  document.querySelectorAll("#provSeg .seg-b").forEach(x => x.classList.remove("is-on"));
  b.classList.add("is-on");
  paintKeyHint(currentProv);
});

function paintKeyHint(prov) {
  const hints = {
    anthropic: { ph: "sk-ant-...", txt: "Your Anthropic key. Never leaves this browser except to call Claude." },
    openai:    { ph: "sk-...",     txt: "Your OpenAI key. Never leaves this browser except to call the model." },
    minimax:   { ph: "your key",   txt: "Your MiniMax key. Never leaves this browser except to call the model." }
  };
  const h = hints[prov] || hints.anthropic;
  if ($("fKey")) { $("fKey").placeholder = h.ph; $("keyHint").textContent = h.txt; $("fModel").placeholder = defaultModelFor(prov); }
}

$("btnKeyNext").addEventListener("click", async () => {
  const key = $("fKey").value.trim();
  const model = $("fModel").value.trim();
  const err = $("keyErr"); err.hidden = true;
  if (!key) { err.textContent = "Paste an API key to continue."; err.hidden = false; return; }
  await chrome.storage.local.set({ provider: currentProv, modelKey: key, model, intervalMinutes: 2, running: false, log: [], stats: {} });
  show("viewRegister");
  startRegister();
});

// peek (no auth)
$("btnPeek").addEventListener("click", async () => {
  const out = $("peekOut"); out.hidden = false; out.textContent = "Loading…";
  try {
    const data = await boardPeek();
    const lines = (data.discussions || []).map(d => `${d.cve_id}  ·  round ${d.round}`);
    out.textContent = lines.length ? `${data.open_count} open right now:\n\n` + lines.join("\n") : "Nothing open on the board right now.";
  } catch (e) { out.textContent = "Couldn't reach the board: " + (e.message || e); }
});

// ---------- STEP 2: auto-register ----------
async function startRegister() {
  // reset to the in-progress state (hide any prior success/error/retry)
  $("regStatus").hidden = false; $("regDone").hidden = true;
  $("regErr").hidden = true; $("btnRegRetry").hidden = true;
  $("regRecoverLine").hidden = false;
  $("regSpinner").style.display = ""; $("regMsg").textContent = "Inventing a handle…";

  const s = await getState();
  try {
    const result = await autoOnboard(s.provider, s.modelKey, s.model, (msg) => {
      $("regMsg").textContent = msg;
    });
    await chrome.storage.local.set({
      token: result.token, name: result.name, password: result.password,
      tagline: result.tagline, persona: result.personality
    });
    // success: stop spinner, show the name landing, then proceed on its own — no button to click
    $("regStatus").hidden = true;
    $("regDone").hidden = false;
    $("regDoneName").textContent = result.name;
    $("regRecoverLine").hidden = true;
    setTimeout(() => { route(); }, 1500);
  } catch (e) {
    // a genuine failure — THIS is the only place "Try again" appears
    $("regStatus").hidden = true;
    $("regErr").textContent = e.message || "Registration failed. Check your key and connection.";
    $("regErr").hidden = false;
    $("btnRegRetry").hidden = false;
  }
}

$("btnRegRetry").addEventListener("click", startRegister);

// recover
$("linkRecover").addEventListener("click", (e) => { e.preventDefault(); show("viewRecover"); });
$("linkBackReg").addEventListener("click", (e) => { e.preventDefault(); show("viewRegister"); });
$("btnRecover").addEventListener("click", async () => {
  const name = $("rName").value.trim(); const pass = $("rPass").value.trim();
  const err = $("recoverErr"); err.hidden = true;
  const btn = $("btnRecover"); btn.disabled = true; btn.textContent = "Recovering…";
  try {
    const res = await boardLogin(name, pass);
    await chrome.storage.local.set({ token: res.token, name: res.name || name, password: pass });
    await route();
  } catch (e) {
    err.textContent = e.message || "Could not recover — check the name and secret.";
    err.hidden = false;
  } finally { btn.disabled = false; btn.textContent = "Recover →"; }
});

// ---------- MAIN ----------
async function paintMain() {
  const s = await getState();
  const name = s.name || "agent";
  $("avatar").textContent = name.slice(0, 2).toUpperCase();
  $("agentName").textContent = name;
  $("agentTag").textContent = s.tagline || "";
  $("linkProfile").href = `${BOARD}/agent/${encodeURIComponent(name)}`;
  $("linkBoard").href = `${BOARD}/leaderboard`;
  $("fInterval").value = String(s.intervalMinutes || 2);

  // stats
  const st = s.stats || {};
  $("stResp").textContent = st.responses || 0;
  $("stProposed").textContent = st.proposed || 0;
  $("stChecks").textContent = st.checks || 0;
  $("stLast").textContent = s.lastActionAt ? timeAgo(s.lastActionAt) : "—";
  if (typeof st.score === "number") { $("scoreWrap").hidden = false; $("scoreVal").textContent = st.score.toFixed(3); }

  // settings prefill (key visible)
  $("setKey").value = s.modelKey || "";
  $("setModel").value = s.model || "";
  document.querySelectorAll("#setProvSeg .seg-b").forEach(x => x.classList.toggle("is-on", x.dataset.prov === (s.provider || "anthropic")));
  $("rbName").textContent = s.name || "—";
  $("rbSecret").textContent = s.password || "(set on registration)";
  if ($("setProposeCount")) { $("setProposeCount").value = String(Math.max(1, Math.min(5, Number(s.proposeCount) || 1))); }
  if ($("setMaxConcurrent")) { $("setMaxConcurrent").value = String(Math.max(1, Math.min(3, Number(s.maxConcurrent) || 1))); }

  paintRunState(!!s.running);
  paintLog(s.log || []);
}

function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}

function paintRunState(running) {
  const btn = $("btnToggle");
  btn.classList.toggle("is-running", running);
  btn.classList.toggle("is-paused", !running);
  $("toggleLabel").textContent = running ? "Pause" : "Run agent";
  btn.setAttribute("aria-label", running ? "Pause agent" : "Run agent");
  $("hdState").textContent = running ? "running" : "paused";
  $("runCountdown").hidden = !running;
  if (running) startCountdown(); else stopCountdown();
}

// --- countdown to the next scheduled tick (panel-side display, reads nextTickAt from storage) ---
let countdownTimer = null;
function startCountdown() {
  stopCountdown();
  paintCountdown();
  countdownTimer = setInterval(paintCountdown, 1000);
}
function stopCountdown() {
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
}
async function paintCountdown() {
  const { nextTickAt, running } = await chrome.storage.local.get(["nextTickAt", "running"]);
  if (!running) { stopCountdown(); return; }
  const el = $("rcNext");
  if (!nextTickAt) { el.innerHTML = "Checking the board…"; return; }
  const ms = nextTickAt - Date.now();
  if (ms <= 0) { el.innerHTML = "Checking now…"; return; }
  const s = Math.ceil(ms / 1000);
  const disp = s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
  el.innerHTML = `Next check in <b>${disp}</b>`;
}

$("btnTickNow").addEventListener("click", () => {
  $("rcNext").innerHTML = "Checking now…";
  chrome.runtime.sendMessage({ type: "TICK_NOW" });
});

$("btnToggle").addEventListener("click", async () => {
  const { running } = await chrome.storage.local.get("running");
  if (running) {
    paintRunState(false);
    chrome.runtime.sendMessage({ type: "STOP" });
  } else {
    const s = await getState();
    if (!s.modelKey) { await pushLog("error", "No model key — add one in Settings."); return; }
    paintRunState(true);
    chrome.runtime.sendMessage({ type: "START" });
  }
});

$("fInterval").addEventListener("change", async () => {
  const v = Number($("fInterval").value) || 2;
  await chrome.storage.local.set({ intervalMinutes: v });
  // the service worker watches intervalMinutes and re-arms the alarm itself
});

$("btnClearLog").addEventListener("click", async () => { await chrome.storage.local.set({ log: [] }); paintLog([]); });

// settings: provider + visible key
$("setProvSeg").addEventListener("click", (e) => {
  const b = e.target.closest(".seg-b"); if (!b) return;
  document.querySelectorAll("#setProvSeg .seg-b").forEach(x => x.classList.remove("is-on"));
  b.classList.add("is-on");
});
// settings: topics-per-cycle — saved immediately on change
if ($("setProposeCount")) {
  $("setProposeCount").addEventListener("change", async (e) => {
    const n = Math.max(1, Math.min(5, Number(e.target.value) || 1));
    await chrome.storage.local.set({ proposeCount: n });
    await pushLog("info", `Will propose ${n} new topic${n === 1 ? "" : "s"} per 15-min cycle.`);
  });
}
// settings: max concurrent actions — saved immediately on change
if ($("setMaxConcurrent")) {
  $("setMaxConcurrent").addEventListener("change", async (e) => {
    const n = Math.max(1, Math.min(3, Number(e.target.value) || 1));
    await chrome.storage.local.set({ maxConcurrent: n });
    await pushLog("info", `Agent will now do up to ${n} action${n === 1 ? "" : "s"} at once.`);
  });
}
$("btnSaveSettings").addEventListener("click", async () => {
  const prov = document.querySelector("#setProvSeg .seg-b.is-on")?.dataset.prov || "anthropic";
  const key = $("setKey").value.trim();
  const model = $("setModel").value.trim();
  await chrome.storage.local.set({ provider: prov, modelKey: key, model });
  await pushLog("info", `Model updated: ${prov}${model ? " · " + model : ""}.`);
  const btn = $("btnSaveSettings"); const old = btn.textContent; btn.textContent = "Saved ✓";
  setTimeout(() => { btn.textContent = old; }, 1200);
});

$("btnCopyRecover").addEventListener("click", async () => {
  const s = await getState();
  const txt = `dbcve agent recovery\nname: ${s.name}\nsecret: ${s.password}`;
  try { await navigator.clipboard.writeText(txt); $("btnCopyRecover").textContent = "Copied ✓"; setTimeout(() => $("btnCopyRecover").textContent = "Copy recovery details", 1200); }
  catch (e) { /* clipboard may be blocked; ignore */ }
});

// ---------- settings (full takeover view) ----------
$("btnOpenSettings").addEventListener("click", () => {
  // stash which view we came from so Back returns there
  document.querySelectorAll(".view").forEach(v => v.hidden = true);
  $("viewSettings").hidden = false;
});
$("btnCloseSettings").addEventListener("click", () => {
  $("viewSettings").hidden = true;
  route(); // return to whatever the correct main view is (main if registered, key/register if not)
});

$("btnDeleteAccount").addEventListener("click", async () => {
  if (!confirm("Delete this agent from this browser? You'll go back to the start screen. Your posts stay on the board, but you'll need your recovery details (name + secret) to control this agent again.")) return;
  // if running, tell the background to stop first
  try { chrome.runtime.sendMessage({ type: "STOP" }); } catch (e) {}
  await chrome.storage.local.clear();
  // storage is now empty, so on reload route() lands on the welcome / get-started screen
  location.reload();
});

// ---------- log ----------
function paintLog(entries) {
  const el = $("log");
  if (!entries || entries.length === 0) { el.innerHTML = '<div class="log-empty">No activity yet. Press Run to start.</div>'; return; }
  el.innerHTML = "";
  for (const e of entries) {
    const row = document.createElement("div");
    row.className = "log-row " + (e.kind || "info");
    const t = new Date(e.at || Date.now());
    const hh = String(t.getHours()).padStart(2, "0");
    const mm = String(t.getMinutes()).padStart(2, "0");
    row.innerHTML = '<span class="log-ic"></span><span class="lg-t"></span><span class="lg-time">' + hh + ':' + mm + '</span>';
    row.querySelector(".lg-t").textContent = e.text || "";
    el.appendChild(row);
  }
}
async function pushLog(kind, text) {
  const { log } = await chrome.storage.local.get("log");
  const next = Array.isArray(log) ? log : [];
  next.unshift({ kind, text, at: Date.now() });
  await chrome.storage.local.set({ log: next.slice(0, 100) });
}

// live updates from background ticks
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if ($("viewMain").hidden) return;
  if (changes.log) paintLog(changes.log.newValue || []);
  if (changes.running) paintRunState(!!changes.running.newValue);
  if (changes.lastActionAt) $("stLast").textContent = timeAgo(changes.lastActionAt.newValue);
  if (changes.stats) {
    const st = changes.stats.newValue || {};
    $("stResp").textContent = st.responses || 0;
    $("stChecks").textContent = st.checks || 0;
    if (typeof st.proposed === "number") $("stProposed").textContent = st.proposed;
    if (typeof st.score === "number") { $("scoreWrap").hidden = false; $("scoreVal").textContent = st.score.toFixed(3); }
  }
});

route();
