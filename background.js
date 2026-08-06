// background.js — the authoritative run loop. MV3 service workers sleep after ~30s, so we rely on
// chrome.alarms to wake us. The alarm fires every minute (the MV3 floor); we decide on each wake
// whether enough time has passed for the next tick, using the user's chosen interval. This makes the
// cadence exact and survives the worker being unloaded between ticks.

import { runOneTick, proposeOneTopic, log } from "./agent.js";

const ALARM = "dbcve-agent-tick";
const PROPOSE_EVERY_MIN = 15;   // independent of the response cadence: try to propose a new topic every 15 min

// ---- concurrency guard -------------------------------------------------------------------------
// The board only tolerates a few concurrent actions; if the extension fires overlapping ticks/proposes
// (e.g. the 1-min alarm wakes again while a slow model call is still running), the extras fail. We run
// AT MOST maxConcurrent actions at once (default 1): while one is in flight, others are skipped, not
// queued. The lock is stored (not just in-memory) with a timestamp so a service-worker restart can't
// leave it stuck — a lock older than LOCK_STALE_MS is treated as abandoned and reclaimed.
const LOCK_STALE_MS = 3 * 60 * 1000;   // an action shouldn't take longer than this; if it does, reclaim

async function acquireSlot(what) {
  const { agentLock, maxConcurrent } = await chrome.storage.local.get(["agentLock", "maxConcurrent"]);
  const cap = Math.max(1, Math.min(4, Number(maxConcurrent) || 1));
  const now = Date.now();
  const held = Array.isArray(agentLock) ? agentLock.filter(l => l && (now - l.at) < LOCK_STALE_MS) : [];
  if (held.length >= cap) {
    // already at capacity — skip this action rather than pile on and get rejected by the board
    await log("idle", `Skipping ${what} — agent is already busy (limit ${cap}). Will try on the next cycle.`);
    return null;
  }
  const token = `${what}-${now}-${Math.random().toString(36).slice(2, 7)}`;
  held.push({ token, at: now, what });
  await chrome.storage.local.set({ agentLock: held });
  return token;
}

async function releaseSlot(token) {
  if (!token) return;
  const { agentLock } = await chrome.storage.local.get("agentLock");
  const held = Array.isArray(agentLock) ? agentLock.filter(l => l && l.token !== token) : [];
  await chrome.storage.local.set({ agentLock: held });
}

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
      // seed both timers: respond soon (now), and first proactive propose one interval out
      await chrome.storage.local.set({ running: true, nextTickAt: Date.now(), nextProposeAt: Date.now() + PROPOSE_EVERY_MIN * 60 * 1000 });
      await armAlarm();
      await runTickNow("started");           // instant first tick
      sendResponse({ ok: true });
    } else if (msg && msg.type === "STOP") {
      await chrome.storage.local.set({ running: false, nextTickAt: null, nextProposeAt: null, agentLock: [] });
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
  const { running, nextTickAt, nextProposeAt } = await chrome.storage.local.get(["running", "nextTickAt", "nextProposeAt"]);
  if (!running) { await chrome.alarms.clear(ALARM); return; }

  const now = Date.now();

  // --- independent propose timer: every PROPOSE_EVERY_MIN, try to start new discussion(s),
  //     regardless of the response cadence, so the agent proactively contributes fresh topics.
  //     How many it proposes per cycle is the user's "topics per cycle" setting (default 1). ---
  if (!nextProposeAt || now >= nextProposeAt) {
    await chrome.storage.local.set({ nextProposeAt: now + PROPOSE_EVERY_MIN * 60 * 1000 });
    const slot = await acquireSlot("propose");
    if (slot) {
      const { proposeCount } = await chrome.storage.local.get("proposeCount");
      const want = Math.max(1, Math.min(5, Number(proposeCount) || 1));
      try {
        await log("check", want > 1
          ? `Time to propose — aiming to start ${want} new topics this cycle…`
          : "Time to propose — looking for a new CVE topic to start…");
        let started = 0;
        for (let i = 0; i < want; i++) {
          const ok = await proposeOneTopic();
          if (ok) { started++; }
          else { break; }   // nothing new to propose (or a failure) — stop this cycle, try again next timer
        }
        if (want > 1) {
          await log("idle", `Propose cycle done — started ${started} of ${want} new discussion${started === 1 ? "" : "s"}.`);
        }
      } catch (e) {
        await log("error", "Propose failed: " + (e && e.message ? e.message : e));
      } finally {
        await releaseSlot(slot);
      }
    }
  }

  // --- response tick, on the user's chosen interval ---
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
  const slot = await acquireSlot("respond");
  if (!slot) { await scheduleNext(); return; }   // busy — don't overlap; reschedule and wait
  try {
    await log("check", "Checking the board for open discussions…");
    await runOneTick();
  } catch (e) {
    await log("error", "Tick failed: " + (e && e.message ? e.message : e));
  } finally {
    await releaseSlot(slot);
    await scheduleNext();
  }
}
