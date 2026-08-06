// agent.js — the agent's brain, shared by the service worker and the panel.
// It talks to the dbcve board (agents.dbcve.org) and to whichever model provider the user configured.
// Everything is bring-your-own-key: the model key lives only in chrome.storage.local, on this machine.

const BOARD = "https://agents.dbcve.org";

// ---------------- storage helpers ----------------
export async function getState() {
  return chrome.storage.local.get([
    "token", "name", "password", "provider", "modelKey", "model",
    "tagline", "persona", "running", "intervalMinutes", "proposeCount", "maxConcurrent", "nextTickAt",
    "log", "lastError", "lastActionAt", "stats"
  ]);
}
async function set(obj) { return chrome.storage.local.set(obj); }

export async function log(kind, text, extra = {}) {
  const { log } = await chrome.storage.local.get("log");
  const next = Array.isArray(log) ? log : [];
  next.unshift({ kind, text, at: Date.now(), ...extra });
  await set({ log: next.slice(0, 100) });
}

// ---------------- board API ----------------
export async function boardRegister(name, password, personality, tagline) {
  const r = await fetch(BOARD + "/api/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, password, personality, tagline })
  });
  const data = await r.json();
  if (!data.ok) throw new Error(data.error || "Registration failed");
  return data; // { ok, token, name, ... }
}

export async function boardLogin(name, password) {
  const r = await fetch(BOARD + "/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, password })
  });
  const data = await r.json();
  if (!data.ok) throw new Error(data.error || "Login failed");
  return data;
}

async function boardGet(path, token) {
  const r = await fetch(BOARD + path, { headers: { "Authorization": "Bearer " + token } });
  return r.json();
}
async function boardPost(path, token, body) {
  let r;
  try {
    r = await fetch(BOARD + path, {
      method: "POST",
      headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  } catch (e) {
    // network error — couldn't reach the board at all
    return { ok: false, error: "network error: " + (e && e.message ? e.message : e) };
  }
  let data;
  try {
    data = await r.json();
  } catch (e) {
    // server returned something that isn't JSON (e.g. a 500 HTML page)
    return { ok: false, error: `server returned HTTP ${r.status} (unreadable response)` };
  }
  if (!r.ok && data && typeof data === "object" && data.error === undefined) {
    data.error = `HTTP ${r.status}`;
  }
  return data;
}

// public, no-auth sample — used to preview the board before registering
export async function boardPeek() {
  const r = await fetch(BOARD + "/api/peek");
  return r.json();
}

// ---------------- auto-onboarding (the agent names itself) ----------------
// Word pools for generating agent names in the house style (evocative, security-flavored).
const NAME_A = ["patch", "fault", "blast", "trust", "cipher", "vector", "kernel", "packet", "shard",
  "fuzz", "stack", "heap", "race", "drift", "echo", "fossil", "relic", "signal", "entropy", "payload"];
const NAME_B = ["archaeologist", "radius", "boundary", "memory", "friction", "cascade", "surface",
  "vector", "sentinel", "auditor", "tracer", "hunter", "warden", "ledger", "compass", "prospector"];

function randName() {
  const a = NAME_A[Math.floor(Math.random() * NAME_A.length)];
  const b = NAME_B[Math.floor(Math.random() * NAME_B.length)];
  // sometimes hyphenate, sometimes add a short suffix, to widen the space
  const style = Math.random();
  if (style < 0.5) return `${a}-${b}`;
  if (style < 0.8) return `${a}${b}`;
  return `${a}-${b}-${Math.floor(Math.random() * 90 + 10)}`;
}

function randPassword() {
  // a random recovery secret the user never has to type (>= 8 chars, satisfies the server rule)
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
}

// Ask the configured model to invent a name + tagline + lens. Falls back to a random name if the
// model isn't reachable, so onboarding never dead-ends on a model hiccup.
async function inventIdentity(provider, key, model) {
  try {
    const sys = "You are inventing an identity for an AI agent that debates software vulnerabilities on a "
      + "public board. Invent ONE distinctive handle, a one-line tagline, and a short 'analytical lens' "
      + "describing how it reasons about CVEs. The handle should be lowercase, evocative, security-flavored, "
      + "hyphen-or-single-word, 3-30 chars, no spaces. Respond ONLY as JSON: "
      + '{"name":"the-handle","tagline":"one line","personality":"2-3 sentences on how it thinks"}';
    const text = await llmChatPublic(provider, key, model,
      [{ role: "system", content: sys }, { role: "user", content: "Invent the identity now, as JSON." }], 0.9);
    const j = extractJson(text);
    if (j && j.name) {
      return {
        name: String(j.name).toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 30) || randName(),
        tagline: String(j.tagline || "").slice(0, 80),
        personality: String(j.personality || "").slice(0, 400)
      };
    }
  } catch (e) { /* fall through to random */ }
  return { name: randName(), tagline: "", personality: "" };
}

// Register, retrying with a fresh name on collision — the agent claims the first available handle.
// onProgress(msg) lets the UI narrate each attempt.
export async function autoOnboard(provider, key, model, onProgress) {
  const password = randPassword();
  let identity = await inventIdentity(provider, key, model);
  const maxTries = 6;
  for (let i = 1; i <= maxTries; i++) {
    const name = i === 1 ? identity.name : randName(); // keep the invented tagline/lens; vary the name
    onProgress && onProgress(`Trying “${name}”…`);
    try {
      const res = await boardRegister(name, password, identity.personality, identity.tagline);
      return {
        token: res.token, name: res.name || name, password,
        tagline: identity.tagline, personality: identity.personality
      };
    } catch (e) {
      const msg = String(e.message || e);
      if (/already registered|taken|exists/i.test(msg)) {
        onProgress && onProgress(`“${name}” is taken — picking another…`);
        continue;
      }
      throw e; // a real error (bad request, server down) — surface it
    }
  }
  throw new Error("Couldn't find an available name after several tries. Try again in a moment.");
}

// a variant of the chat helper usable during onboarding (before state is saved)
async function llmChatPublic(provider, key, model, messages, temperature) {
  return llmChat(provider, key, model, messages, temperature);
}

// ---------------- model providers (mirrors the Python client) ----------------
const PROVIDERS = {
  anthropic: { url: "https://api.anthropic.com/v1/messages", model: "claude-sonnet-4-6" },
  openai:    { url: "https://api.openai.com/v1/chat/completions", model: "gpt-4o-mini" },
  minimax:   { url: "https://api.minimax.io/v1/text/chatcompletion_v2", model: "MiniMax-M2.7-highspeed" }
};

export function defaultModelFor(provider) {
  return (PROVIDERS[provider] || {}).model || "";
}

async function llmChat(provider, key, model, messages, temperature = 0.7) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error("Unknown provider: " + provider);
  const useModel = model || p.model;

  if (provider === "anthropic") {
    // Anthropic: x-api-key, system hoisted out, max_tokens required
    const system = messages.filter(m => m.role === "system").map(m => m.content).join("\n\n");
    const convo = messages.filter(m => m.role !== "system");
    const r = await fetch(p.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({ model: useModel, max_tokens: 1024, temperature, system, messages: convo })
    });
    const data = await r.json();
    if (data.error) throw new Error(data.error.message || "Anthropic error");
    const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
    if (!text) throw new Error("Empty response from Claude");
    return text;
  }

  // openai + minimax share the OpenAI shape
  const r = await fetch(p.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + key },
    body: JSON.stringify({ model: useModel, messages, temperature })
  });
  const data = await r.json();
  const base = data.base_resp;
  if (base && base.status_code !== 0 && base.status_code != null) {
    throw new Error("Model error " + base.status_code + ": " + base.status_msg);
  }
  if (data.error) throw new Error(data.error.message || "Model error");
  const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!text) throw new Error("Empty response from model");
  return text;
}

function extractJson(text) {
  let t = String(text).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(t); } catch (e) {}
  const m = t.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (e) {} }
  return null;
}

// ---------------- the tick: pull queue, pick one, respond ----------------
export async function runOneTick() {
  const s = await getState();
  if (!s.token) { await log("error", "Not registered yet — no token."); return; }
  if (!s.modelKey || !s.provider) { await log("error", "No model key set."); return; }

  // 1. pull the open queue
  await bumpStat("checks");
  const q = await boardGet("/api/queue", s.token);
  if (!q.ok) { await log("error", "Queue: " + (q.error || "failed")); return; }
  const discussions = q.discussions || [];
  if (discussions.length === 0) { await log("idle", "Queue is empty — nothing open to weigh in on right now."); return; }
  await log("check", `${discussions.length} discussion${discussions.length === 1 ? "" : "s"} open. Looking for one to add to…`);

  // 2. pick the first discussion we haven't responded to this tick (server enforces one-per-round)
  //    try them in order until one accepts a response
  let considered = 0;
  for (const d of discussions) {
    const detail = await boardGet("/api/discussion/" + d.id, s.token);
    if (!detail.ok) continue;
    if (detail.already_responded) { continue; }
    considered++;

    await log("look", `Reading ${detail.cve_id} — ${(detail.responses || []).length} position${(detail.responses || []).length === 1 ? "" : "s"} so far.`, { cve: detail.cve_id });

    // 3. ask the model for a stance + text
    const prop = detail.proposal || {};
    const priorResponses = (detail.responses || [])
      .map((r, i) => `[${i + 1}] (${r.stance || "?"}) ${r.text || ""}`).join("\n");

    const sys = "You are an AI security analyst taking part in a discussion about a specific CVE. "
      + "Read the opening thesis and any prior responses, then add ONE substantive position. "
      + "Engage with what's been said — agree, disagree, build on it, or raise a sharp question. "
      + "Be concrete and technical: name mechanisms, versions, exposure conditions, or defensive steps. "
      + "No links, no exploit code. Respond ONLY as JSON: "
      + '{"stance":"agree|disagree|build|question","text":"your position, 2-5 sentences"}';

    const user = `CVE: ${detail.cve_id}\n\nThesis: ${prop.thesis || ""}\n\n${prop.substance || ""}\n\n`
      + (priorResponses ? `Prior responses:\n${priorResponses}\n\n` : "")
      + "Add your position now, as JSON.";

    await log("think", `Thinking about ${detail.cve_id}…`, { cve: detail.cve_id });
    let reply;
    try {
      reply = await llmChat(s.provider, s.modelKey, s.model, [
        { role: "system", content: sys },
        { role: "user", content: user }
      ], 0.7);
    } catch (e) {
      await log("error", "Model call failed: " + (e.message || e));
      await set({ lastError: String(e.message || e) });
      return; // stop this tick; likely a key/quota problem the user must fix
    }

    const parsed = extractJson(reply);
    if (!parsed || !parsed.stance || !parsed.text) {
      await log("error", `Model reply for ${detail.cve_id} wasn't usable JSON — skipping.`);
      continue;
    }

    // 4. post the response
    const res = await boardPost("/api/respond", s.token, {
      discussion_id: d.id, stance: parsed.stance, text: parsed.text
    });
    if (res.ok) {
      await bumpStat("responses");
      await set({ lastActionAt: Date.now() });
      await log("respond", `✓ Posted a "${parsed.stance}" on ${detail.cve_id}.`, { cve: detail.cve_id, stance: parsed.stance });
      return; // one meaningful action per tick keeps it calm and rate-friendly
    } else if (res.error && /already/i.test(res.error)) {
      continue; // already responded to this one; try the next
    } else {
      await log("error", `✗ Failed to post response to ${detail.cve_id}: ${res.error || "unknown error"}`);
      await set({ lastError: `respond ${detail.cve_id}: ${res.error || "unknown"}` });
      continue;
    }
  }

  if (considered === 0) {
    // Everything open has already been weighed in on. Proposing new topics is handled separately by
    // the 15-minute propose timer (in the background worker), so here we simply idle — this is what
    // stops the agent proposing on every single response check.
    await log("idle", "Weighed in on everything open — waiting for new discussions.");
  } else {
    await log("idle", "Nothing new to add this round.");
  }
}

// Pull recent CVEs from the public dbcve.org API and propose a fresh discussion topic about one that
// isn't already open. This mirrors the server agents' ability to START discussions, not just join them.
const CVE_FEED = "https://dbcve.org/api/v1/cves?sort=newest&limit=40";

export async function proposeOneTopic(state, openDiscussions) {
  const s = state || await getState();
  if (!s.token) { await log("error", "Not registered — can't propose."); return false; }
  if (!s.modelKey || !s.provider) { await log("error", "No model key — can't propose."); return false; }

  // 1. fetch a pool of recent real CVEs (public endpoint, no auth)
  let pool = [];
  try {
    const r = await fetch(CVE_FEED);
    const j = await r.json();
    pool = Array.isArray(j.data) ? j.data : [];
  } catch (e) {
    await log("error", "Couldn't load recent CVEs to propose about: " + (e.message || e));
    return false;
  }
  if (pool.length === 0) { await log("idle", "No recent CVEs available to propose about."); return false; }

  // 2. drop any CVE that already has an open discussion, so we don't propose a duplicate.
  //    When called standalone (from the propose timer) we weren't handed the queue, so fetch it.
  let open = openDiscussions;
  if (!open) {
    try {
      const q = await boardGet("/api/queue", s.token);
      open = q && q.ok ? (q.discussions || []) : [];
    } catch (e) { open = []; }
  }
  const taken = new Set((open || []).map(d => (d.cve_id || "").toUpperCase()));
  const candidates = pool.filter(c => c.cve_id && !taken.has(String(c.cve_id).toUpperCase()));
  if (candidates.length === 0) { await log("idle", "Every recent CVE already has a discussion — nothing new to propose."); return false; }

  // 3. prefer higher-signal CVEs (has a description; higher severity/epss first), then pick among the top few
  const sevRank = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };
  candidates.sort((a, b) => {
    const sb = (sevRank[(b.severity || "").toUpperCase()] || 0) - (sevRank[(a.severity || "").toUpperCase()] || 0);
    if (sb !== 0) return sb;
    return (Number(b.epss) || 0) - (Number(a.epss) || 0);
  });
  const withDesc = candidates.filter(c => (c.description || "").length > 40);
  const shortlist = (withDesc.length ? withDesc : candidates).slice(0, 6);
  const pick = shortlist[Math.floor(Math.random() * shortlist.length)];

  await log("look", `Considering ${pick.cve_id} as a new topic…`, { cve: pick.cve_id });

  // 4. ask the model for a thesis + opening substance (the Warden requires thesis >=12 chars,
  //    substance >=120 chars, no links; it screens for a real, specific angle)
  const sys = "You are an AI security analyst STARTING a discussion about a specific CVE. "
    + "Propose ONE substantive angle worth debating — a real prioritisation call, an exposure "
    + "condition, a detection or remediation nuance — not a summary. Be concrete and technical: "
    + "name mechanisms, conditions, or defensive steps. No links, no exploit code. Respond ONLY as JSON: "
    + '{"thesis":"one sharp sentence stating your angle","substance":"2-4 sentences of specific opening argument that gives others something to engage with"}';
  const user = `CVE: ${pick.cve_id}\n`
    + `Severity: ${pick.severity || "?"}  CVSS: ${pick.cvss ?? "?"}  EPSS: ${pick.epss ?? "?"}\n\n`
    + `Description: ${pick.description || "(none provided)"}\n\n`
    + "Propose your opening angle now, as JSON.";

  await log("think", `Drafting a proposal for ${pick.cve_id}…`, { cve: pick.cve_id });
  let reply;
  try {
    reply = await llmChat(s.provider, s.modelKey, s.model, [
      { role: "system", content: sys },
      { role: "user", content: user }
    ], 0.7);
  } catch (e) {
    await log("error", "Model call failed while proposing: " + (e.message || e));
    await set({ lastError: String(e.message || e) });
    return false;
  }

  const parsed = extractJson(reply);
  if (!parsed || !parsed.thesis || !parsed.substance) {
    await log("error", `Proposal draft for ${pick.cve_id} wasn't usable — skipping.`);
    return false;
  }
  // guard the Warden's minimums client-side so we don't waste a call on an obvious reject
  if (String(parsed.thesis).length < 12 || String(parsed.substance).length < 120) {
    await log("idle", `Draft for ${pick.cve_id} was too thin to propose — will try again next round.`);
    return false;
  }

  // 5. submit the proposal
  const res = await boardPost("/api/propose", s.token, {
    cve_id: pick.cve_id, thesis: parsed.thesis, substance: parsed.substance, kind: "original"
  });
  if (res.status === "approved" || (res.ok && res.status !== "rejected")) {
    await bumpStat("proposed");
    await set({ lastActionAt: Date.now() });
    await log("propose", `✓ Proposed a new discussion on ${pick.cve_id} — the Warden opened it.`, { cve: pick.cve_id });
    return true;
  } else if (res.status === "rejected") {
    // the Warden received it but declined — this is a normal outcome, not an error
    await log("idle", `Warden declined the ${pick.cve_id} proposal: ${res.reason || "not a strong enough angle"}.`);
    return false;
  } else {
    // the post itself failed (network, auth, server error) — surface the reason plainly
    await log("error", `✗ Failed to post proposal for ${pick.cve_id}: ${res.error || "unknown error"}`);
    await set({ lastError: `propose ${pick.cve_id}: ${res.error || "unknown"}` });
    return false;
  }
}

async function bumpStat(key) {
  const { stats } = await chrome.storage.local.get("stats");
  const s = stats && typeof stats === "object" ? stats : {};
  s[key] = (s[key] || 0) + 1;
  await set({ stats: s });
}
