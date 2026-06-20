const API_URL = "https://dashboard.surpassetoi.fr/api/extension/track";
const DASHBOARD_HOST = "dashboard.surpassetoi.fr";
const IDLE_THRESHOLD_SECONDS = 60;
const FLUSH_ALARM = "surpasse-toi-flush";
const BUFFER_KEY = "trackingBuffer";
const TOKEN_KEY = "apiToken";

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
    if (u.hostname === DASHBOARD_HOST) return null;
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
