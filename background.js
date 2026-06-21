const API_URL = "https://dashboard.surpassetoi.fr/api/extension/track";
const FOCUS_LISTS_API = "https://dashboard.surpassetoi.fr/api/focus-lists";
const FOCUS_SESSIONS_API = "https://dashboard.surpassetoi.fr/api/focus-sessions";
const IDLE_THRESHOLD_SECONDS = 60;
const FLUSH_ALARM = "surpasse-toi-flush";
const FOCUS_ALARM = "focusEnd";
const BUFFER_KEY = "trackingBuffer";
const TOKEN_KEY = "apiToken";
const FOCUS_SESSION_KEY = "activeFocusSession";
const WHITELIST_BLOCK_RULE_ID = 1000;

let activeDomain = null;
let segmentStartedAt = null;
let windowFocused = true;
let userIdle = false;

chrome.idle.setDetectionInterval(IDLE_THRESHOLD_SECONDS);

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(FLUSH_ALARM, { periodInMinutes: 1 });
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(FLUSH_ALARM, { periodInMinutes: 1 });
});

function extractDomain(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.hostname;
  } catch {
    return null;
  }
}

function todayString(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function flushSegmentIfAny() {
  if (!activeDomain || segmentStartedAt === null) return;
  const now = Date.now();
  const startedAt = segmentStartedAt;
  const elapsedMs = now - startedAt;
  const domain = activeDomain;
  segmentStartedAt = null;
  activeDomain = null;
  if (elapsedMs < 1000) return;
  const seconds = Math.floor(elapsedMs / 1000);
  const date = todayString(startedAt);
  const { [BUFFER_KEY]: buffer = {} } = await chrome.storage.local.get(BUFFER_KEY);
  if (!buffer[date]) buffer[date] = {};
  buffer[date][domain] = (buffer[date][domain] || 0) + seconds;
  await chrome.storage.local.set({ [BUFFER_KEY]: buffer });
}

async function recomputeActiveSegment() {
  await flushSegmentIfAny();
  if (!windowFocused || userIdle) return;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) return;
  const domain = extractDomain(tab.url);
  if (!domain) return;
  activeDomain = domain;
  segmentStartedAt = Date.now();
}

chrome.tabs.onActivated.addListener(() => { recomputeActiveSegment(); });

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url) return;
  if (!tab.active) return;
  recomputeActiveSegment();
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  windowFocused = windowId !== chrome.windows.WINDOW_ID_NONE;
  recomputeActiveSegment();
});

chrome.idle.onStateChanged.addListener((state) => {
  userIdle = state !== "active";
  recomputeActiveSegment();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== FLUSH_ALARM) return;
  await flushSegmentIfAny();
  await sendBuffer();
  await recomputeActiveSegment();
});

async function sendBuffer() {
  const { [TOKEN_KEY]: token, [BUFFER_KEY]: buffer = {} } =
    await chrome.storage.local.get([TOKEN_KEY, BUFFER_KEY]);
  if (!token) return;

  for (const date of Object.keys(buffer)) {
    for (const domain of Object.keys(buffer[date])) {
      const durationSeconds = buffer[date][domain];
      if (!durationSeconds || durationSeconds <= 0) continue;
      try {
        const res = await fetch(API_URL, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ domain, durationSeconds, date })
        });
        if (res.ok) {
          delete buffer[date][domain];
          if (Object.keys(buffer[date]).length === 0) delete buffer[date];
          await chrome.storage.local.set({ [BUFFER_KEY]: buffer });
        }
      } catch {
        // garde le buffer pour retry
      }
    }
  }
}

function buildDynamicRules(listType, domains) {
  const rules = [];
  if (listType === "blacklist") {
    domains.forEach((domain, i) => {
      rules.push({
        id: i + 1,
        priority: 1,
        action: { type: "block" },
        condition: { urlFilter: `||${domain}`, resourceTypes: ["main_frame"] }
      });
    });
  } else if (listType === "whitelist") {
    domains.forEach((domain, i) => {
      rules.push({
        id: i + 1,
        priority: 2,
        action: { type: "allow" },
        condition: { urlFilter: `||${domain}`, resourceTypes: ["main_frame"] }
      });
    });
    rules.push({
      id: WHITELIST_BLOCK_RULE_ID,
      priority: 1,
      action: { type: "block" },
      condition: { urlFilter: "*", resourceTypes: ["main_frame"] }
    });
  }
  return rules;
}

async function clearDynamicRules() {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((r) => r.id);
  if (removeRuleIds.length) {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds });
  }
}

async function startFocusSession(list, durationMin) {
  const { [TOKEN_KEY]: token } = await chrome.storage.local.get(TOKEN_KEY);

  const res = await fetch(FOCUS_SESSIONS_API, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ focusListId: list.id, durationMin })
  });
  if (!res.ok) throw new Error("Impossible de démarrer la session");
  const data = await res.json();
  const sessionId = data.id ?? data.sessionId;

  const rules = buildDynamicRules(list.type, list.domains || []);
  await clearDynamicRules();
  if (rules.length) {
    await chrome.declarativeNetRequest.updateDynamicRules({ addRules: rules });
  }

  const state = {
    sessionId,
    focusListId: list.id,
    listName: list.name,
    listType: list.type,
    domains: list.domains || [],
    durationMin,
    startedAt: Date.now(),
    frictionType: list.frictionType,
    frictionChars: list.frictionChars,
    frictionDelay: list.frictionDelay,
    abandonCount: 0
  };
  await chrome.storage.local.set({ [FOCUS_SESSION_KEY]: state });
  chrome.alarms.create(FOCUS_ALARM, { delayInMinutes: durationMin });
  return state;
}

async function endFocusSession(abandoned) {
  const { [FOCUS_SESSION_KEY]: state } = await chrome.storage.local.get(FOCUS_SESSION_KEY);
  if (!state) return;

  await clearDynamicRules();
  chrome.alarms.clear(FOCUS_ALARM);

  const { [TOKEN_KEY]: token } = await chrome.storage.local.get(TOKEN_KEY);
  const abandonCount = abandoned ? (state.abandonCount || 0) + 1 : state.abandonCount || 0;
  try {
    await fetch(FOCUS_SESSIONS_API, {
      method: "PATCH",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        id: state.sessionId,
        endedAt: new Date().toISOString(),
        abandoned: !!abandoned,
        abandonCount
      })
    });
  } catch {
    // best effort, on nettoie quand même l'état local
  }

  await chrome.storage.local.remove(FOCUS_SESSION_KEY);
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== FOCUS_ALARM) return;
  await endFocusSession(false);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "startFocusSession") {
    startFocusSession(message.list, message.durationMin)
      .then((state) => sendResponse({ ok: true, state }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
  if (message?.type === "endFocusSession") {
    endFocusSession(!!message.abandoned)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
  if (message?.type === "getFocusSession") {
    chrome.storage.local.get(FOCUS_SESSION_KEY).then(({ [FOCUS_SESSION_KEY]: state }) => {
      sendResponse({ ok: true, state: state || null });
    });
    return true;
  }
  return false;
});
