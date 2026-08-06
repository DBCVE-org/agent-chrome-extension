// background.js — the authoritative run loop. MV3 service workers sleep after ~30s, so we rely on
// chrome.alarms to wake us. The alarm fires every minute (the MV3 floor); we decide on each wake
// whether enough time has passed for the next tick, using the user's chosen interval. This makes the
// cadence exact and survives the worker being unloaded between ticks.

import { runOneTick, log } from "./agent.js";

const ALARM = "dbcve-agent-tick";

// --- lifecycle: keep the panel-open behavior, and re-arm if we were running ---
chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);

async function init() {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  const { running } = await chrome.storage.local.get("running");
  if (running) await armAlarm();
}

// --- the panel talks to us directly, so start/stop is immediate and reliable ---
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg && msg.type === "START") {
      await chrome.storage.local.set({ running: true, nextTickAt: Date.now() });
      await armAlarm();
      await runTickNow("started");           // instant first tick
      sendResponse({ ok: true });
    } else if (msg && msg.type === "STOP") {
      await chrome.storage.local.set({ running: false, nextTickAt: null });
      await chrome.alarms.clear(ALARM);
      await log("info", "Agent paused.");
      sendResponse({ ok: true });
    } else if (msg && msg.type === "TICK_NOW") {
      await runTickNow("manual");
      sendResponse({ ok: true });
    }
  })();
  return true; // keep the message channel open for the async response
});

// re-arm the alarm defensively whenever the interval changes while running
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local") return;
  if (changes.intervalMinutes) {
    const { running } = await chrome.storage.local.get("running");
    if (running) await armAlarm();
  }
});

async function armAlarm() {
  // 1-minute cadence (the MV3 minimum); we gate the actual tick by elapsed time ourselves.
  await chrome.alarms.clear(ALARM);
  chrome.alarms.create(ALARM, { periodInMinutes: 1 });
  await scheduleNext();
}

async function scheduleNext() {
  const { intervalMinutes } = await chrome.storage.local.get("intervalMinutes");
  const mins = Math.max(1, Number(intervalMinutes) || 2);
  await chrome.storage.local.set({ nextTickAt: Date.now() + mins * 60 * 1000 });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM) return;
  const { running, nextTickAt } = await chrome.storage.local.get(["running", "nextTickAt"]);
  if (!running) { await chrome.alarms.clear(ALARM); return; }

  // heartbeat: show we're alive and checking, even between real ticks
  const now = Date.now();
  if (nextTickAt && now < nextTickAt) {
    const secs = Math.round((nextTickAt - now) / 1000);
    await log("heartbeat", `Awake — next check in ~${secs >= 60 ? Math.round(secs / 60) + "m" : secs + "s"}.`);
    return;
  }
  await runTickNow("scheduled");
});

async function runTickNow(source) {
  const { running } = await chrome.storage.local.get("running");
  if (!running && source !== "manual") return;
  try {
    await log("check", "Checking the board for open discussions…");
    await runOneTick();
  } catch (e) {
    await log("error", "Tick failed: " + (e && e.message ? e.message : e));
  } finally {
    await scheduleNext();
  }
}
