const API_URL = "https://dashboard.surpassetoi.fr/api/extension/track";
const FOCUS_LISTS_API = "https://dashboard.surpassetoi.fr/api/extension/focus-lists";
const FOCUS_SESSIONS_API = "https://dashboard.surpassetoi.fr/api/focus-sessions";
const IDLE_THRESHOLD_SECONDS = 60;
// Garde-fou anti-veille : durée maximale plausible pour UN segment. Le flush alarm
// tourne toutes les 60 s et redémarre un segment frais à chaque passage, donc un
// segment légitime (lecture continue d'une page) ne dépasse jamais ~60 s. On laisse
// 90 s de marge au-dessus de cet intervalle. Tout segment plus long = la machine a
// dormi / été suspendue pendant le décompte → on l'ignore au lieu de créditer l'écart.
// (Le prompt suggérait 30-60 s, mais ce seuil découperait à tort les segments de ~60 s
// qui sont normaux ici puisque le flush est à 60 s — d'où 90 s.)
const MAX_SEGMENT_MS = 90 * 1000;
const FLUSH_ALARM = "surpasse-toi-flush";
const FOCUS_ALARM = "focusEnd";
const BUFFER_KEY = "trackingBuffer";
const TOKEN_KEY = "apiToken";
const FOCUS_SESSION_KEY = "activeFocusSession";
// Miroir persistant du segment en cours (cf. "Persistance du segment" dans CONTEXT.md).
// Écrit à chaque démarrage de segment, retiré à chaque flush. Permet de récupérer le
// temps d'un segment en cours si le service worker MV3 est tué avant le prochain flush.
const ACTIVE_SEGMENT_KEY = "activeSegment";
const WHITELIST_BLOCK_RULE_ID = 1000;

let activeDomain = null;
let activePath = null;
let segmentStartedAt = null;
let windowFocused = true;
let userIdle = false;

chrome.idle.setDetectionInterval(IDLE_THRESHOLD_SECONDS);

// Recale windowFocused/userIdle sur l'état réel au (re)démarrage du service worker,
// au lieu de partir sur les valeurs en dur true/false — celles-ci seraient
// permissives à tort si le SW redémarre alors que l'utilisateur est déjà
// absent/idle ou sur une autre fenêtre.
async function syncFocusAndIdleState() {
  try {
    const idleState = await chrome.idle.queryState(IDLE_THRESHOLD_SECONDS);
    userIdle = idleState !== "active";
    const focusedWindow = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
    windowFocused = !!focusedWindow && focusedWindow.id !== chrome.windows.WINDOW_ID_NONE && !!focusedWindow.focused;
  } catch {
    // best effort — la vérification live dans recomputeActiveSegment() reste le filet de sécurité
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(FLUSH_ALARM, { periodInMinutes: 1 });
  recoverOrphanSegment();
  syncFocusAndIdleState();
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(FLUSH_ALARM, { periodInMinutes: 1 });
  recoverOrphanSegment();
  syncFocusAndIdleState();
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

// Pathname uniquement — JAMAIS la query string (?...) ni le fragment (#...),
// `URL.pathname` ne les inclut jamais par construction. Retourne null si le
// pathname n'est pas significatif (absent ou simple "/").
function extractPath(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const pathname = u.pathname;
    if (!pathname || pathname === "/") return null;
    return pathname;
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

// `buffer[date][domain]` est un objet `{ pathKey: seconds }`, où `pathKey` est le
// pathname réel ou "" (chaîne vide) pour "pas de path significatif". On garde la
// compat avec l'ancien format (nombre direct, avant l'ajout du path) en migrant
// à la volée vers `{ "": ancienneValeur }` dès qu'on retombe sur ce cas.
function migrateDomainEntry(entry) {
  if (typeof entry === "number") return { "": entry };
  return entry || {};
}

// Crédite au buffer journalier la durée d'un segment (domaine, path, [startedAt, now]),
// en appliquant les mêmes garde-fous quel que soit l'appelant (flush normal OU
// récupération d'un segment orphelin après un kill du SW) :
//  - ignore les segments < 1 s ;
//  - ignore tout segment plus long que MAX_SEGMENT_MS (trou de veille/suspension/kill),
//    pour ne jamais créditer un intervalle pendant lequel le décompte n'a pas tourné.
async function creditSegmentToBuffer(domain, path, startedAt, now) {
  const elapsedMs = now - startedAt;
  if (elapsedMs < 1000) return;
  if (elapsedMs > MAX_SEGMENT_MS) {
    console.warn(
      `[surpasse-toi] Segment ignoré : ${Math.round(elapsedMs / 1000)}s écoulées (> ${MAX_SEGMENT_MS / 1000}s) ` +
      `pour ${domain}${path || ""} — probable veille/suspension/kill du SW, aucun temps crédité.`
    );
    return;
  }
  const seconds = Math.floor(elapsedMs / 1000);
  const date = todayString(startedAt);
  const pathKey = path || "";
  const { [BUFFER_KEY]: buffer = {} } = await chrome.storage.local.get(BUFFER_KEY);
  if (!buffer[date]) buffer[date] = {};
  const domainEntry = migrateDomainEntry(buffer[date][domain]);
  domainEntry[pathKey] = (domainEntry[pathKey] || 0) + seconds;
  buffer[date][domain] = domainEntry;
  await chrome.storage.local.set({ [BUFFER_KEY]: buffer });
}

async function flushSegmentIfAny() {
  if (!activeDomain || segmentStartedAt === null) return;
  const now = Date.now();
  const startedAt = segmentStartedAt;
  const domain = activeDomain;
  const path = activePath;
  segmentStartedAt = null;
  activeDomain = null;
  activePath = null;
  // Le segment en mémoire est désormais clos : on retire son miroir persistant pour
  // qu'il ne soit pas récupéré une seconde fois comme "orphelin" au prochain réveil.
  await chrome.storage.local.remove(ACTIVE_SEGMENT_KEY);
  await creditSegmentToBuffer(domain, path, startedAt, now);
}

// Récupération d'un segment orphelin : si le service worker MV3 a été tué pendant un
// segment en cours, les variables en mémoire ont été perdues mais le miroir persistant
// (ACTIVE_SEGMENT_KEY) a survécu. Au réveil, on crédite le temps écoulé comme un flush
// normal (mêmes garde-fous via creditSegmentToBuffer, dont le cap MAX_SEGMENT_MS qui
// neutralise le cas où le kill a coïncidé avec une veille). On ne fait rien si un segment
// est déjà actif en mémoire (le SW est vivant, le flush normal s'en chargera) — évite
// tout double comptage.
async function recoverOrphanSegment() {
  if (activeDomain || segmentStartedAt !== null) return;
  const { [ACTIVE_SEGMENT_KEY]: seg } = await chrome.storage.local.get(ACTIVE_SEGMENT_KEY);
  if (!seg || !seg.domain || typeof seg.startedAt !== "number") return;
  await chrome.storage.local.remove(ACTIVE_SEGMENT_KEY);
  await creditSegmentToBuffer(seg.domain, seg.path || null, seg.startedAt, Date.now());
}

// Filet de sécurité à l'ouverture : si le service worker MV3 a été tué par Chrome
// (~30 s d'inactivité) puis réveillé par un évènement, windowFocused/userIdle
// retombent sur leurs valeurs par défaut en mémoire (true/false) — permissives et
// potentiellement fausses. On revérifie donc l'état réel en direct juste avant
// d'ouvrir un nouveau segment, plutôt que de faire confiance au cache. Les
// listeners onFocusChanged/onActivated/onStateChanged restent la voie rapide pour
// la réactivité immédiate ; cette vérification ne les remplace pas.
async function isReallyActiveNow() {
  const idleState = await chrome.idle.queryState(IDLE_THRESHOLD_SECONDS);
  if (idleState !== "active") return false;
  const focusedWindow = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
  if (!focusedWindow || focusedWindow.id === chrome.windows.WINDOW_ID_NONE) return false;
  return !!focusedWindow.focused;
}

// Un média en lecture active (son audible dans l'onglet) signifie que l'utilisateur
// suit toujours du contenu même sans interaction clavier/souris — chrome.idle ne le
// sait pas et déclencherait sinon une coupure de segment à tort (ex. vidéo/podcast
// regardé sans bouger la souris pendant > seuil d'inactivité).
async function isActiveTabAudible() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return !!tab?.audible;
}

async function recomputeActiveSegment() {
  // Avant tout : créditer un éventuel segment orphelin laissé par un kill du SW.
  await recoverOrphanSegment();
  await flushSegmentIfAny();
  if (!windowFocused) return;
  const audible = await isActiveTabAudible();
  // Media qui joue activement (son audible) = utilisateur toujours engagé, même sans
  // mouvement souris/clavier. On ignore l'état idle (chrome.idle ET la revérification
  // live) dans ce cas précis, pour ne pas couper le segment d'une vidéo/podcast écouté.
  if (userIdle && !audible) return;
  if (!audible && !(await isReallyActiveNow())) return;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) return;
  const domain = extractDomain(tab.url);
  if (!domain) return;
  activeDomain = domain;
  activePath = extractPath(tab.url);
  segmentStartedAt = Date.now();
  // Miroir persistant immédiat : si le SW est tué avant le prochain flush, ce segment
  // pourra être récupéré au réveil au lieu d'être perdu.
  await chrome.storage.local.set({
    [ACTIVE_SEGMENT_KEY]: { domain: activeDomain, path: activePath, startedAt: segmentStartedAt }
  });
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
  // Récupère d'abord un segment orphelin (kill du SW depuis le dernier flush) pour
  // que son temps soit crédité puis envoyé dans le même cycle.
  await recoverOrphanSegment();
  await flushSegmentIfAny();
  await sendBuffer();
  await recomputeActiveSegment();
});

// Secondes écoulées depuis minuit local pour le timestamp donné.
function secondsSinceLocalMidnight(ts) {
  const d = new Date(ts);
  return d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds();
}

// Garde-fou de validation : le total cumulé d'AUJOURD'HUI ne peut jamais dépasser
// le temps écoulé depuis minuit local. Si c'est le cas, un bug a réintroduit du
// sur-comptage (ex. crédit de temps de veille) — on alerte bruyamment dans la
// console du service worker. On ne bloque pas l'envoi : le cap par segment empêche
// déjà l'accumulation aberrante, et droper une journée entière sur un faux positif
// (changement d'heure, etc.) ferait plus de mal que de bien. C'est un fil d'alarme.
function auditDailyTotals(buffer) {
  const today = todayString(Date.now());
  const dayEntry = buffer[today];
  if (!dayEntry) return;
  let total = 0;
  for (const domain of Object.keys(dayEntry)) {
    const domainEntry = migrateDomainEntry(dayEntry[domain]);
    for (const pathKey of Object.keys(domainEntry)) {
      total += domainEntry[pathKey] || 0;
    }
  }
  const elapsed = secondsSinceLocalMidnight(Date.now());
  // Petite marge pour l'arrondi et un éventuel léger décalage d'horloge.
  if (total > elapsed + 120) {
    console.warn(
      `[surpasse-toi] INCOHÉRENCE : total navigué aujourd'hui = ${total}s ` +
      `(${(total / 3600).toFixed(2)}h) > temps écoulé depuis minuit = ${elapsed}s ` +
      `(${(elapsed / 3600).toFixed(2)}h). Sur-comptage probable — à investiguer.`
    );
  }
}

async function sendBuffer() {
  const { [TOKEN_KEY]: token, [BUFFER_KEY]: buffer = {} } =
    await chrome.storage.local.get([TOKEN_KEY, BUFFER_KEY]);
  if (!token) return;

  auditDailyTotals(buffer);

  for (const date of Object.keys(buffer)) {
    for (const domain of Object.keys(buffer[date])) {
      const domainEntry = migrateDomainEntry(buffer[date][domain]);

      for (const pathKey of Object.keys(domainEntry)) {
        const durationSeconds = domainEntry[pathKey];
        if (!durationSeconds || durationSeconds <= 0) continue;
        try {
          const body = { domain, durationSeconds, date };
          // N'envoie `path` que s'il est réellement renseigné — jamais une chaîne vide.
          if (pathKey) body.path = pathKey;

          const res = await fetch(API_URL, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${token}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify(body)
          });
          if (res.ok) {
            delete domainEntry[pathKey];
            if (Object.keys(domainEntry).length === 0) {
              delete buffer[date][domain];
            } else {
              buffer[date][domain] = domainEntry;
            }
            if (Object.keys(buffer[date]).length === 0) delete buffer[date];
            await chrome.storage.local.set({ [BUFFER_KEY]: buffer });
          }
        } catch {
          // garde le buffer pour retry
        }
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
