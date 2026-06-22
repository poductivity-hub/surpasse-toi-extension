const TOKEN_KEY = "apiToken";
const IDLE_THRESHOLD_KEY = "idleThresholdSeconds";
const DEFAULT_IDLE_THRESHOLD_SECONDS = 60;
const FOCUS_LISTS_API = "https://dashboard.surpassetoi.fr/api/focus-lists";
const DURATIONS = [15, 30, 45, 60, 75, 90, 120];

let selectedDuration = 30;
let timerInterval = null;

function idleThresholdFieldHtml(value) {
  return `
    <div class="field">
      <label for="idleThreshold">Seuil d'inactivité (secondes)</label>
      <input id="idleThreshold" type="number" min="1" step="1" value="${value}" />
    </div>
  `;
}

function bindIdleThresholdField() {
  const input = document.getElementById("idleThreshold");
  if (!input) return;
  input.addEventListener("change", async () => {
    const value = Math.max(1, Number(input.value) || DEFAULT_IDLE_THRESHOLD_SECONDS);
    input.value = value;
    await chrome.storage.local.set({ [IDLE_THRESHOLD_KEY]: value });
  });
}

async function getIdleThreshold() {
  const { [IDLE_THRESHOLD_KEY]: value } = await chrome.storage.local.get(IDLE_THRESHOLD_KEY);
  return value || DEFAULT_IDLE_THRESHOLD_SECONDS;
}

async function sendMessage(message) {
  return chrome.runtime.sendMessage(message);
}

function formatRemaining(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

async function renderTokenForm(root) {
  const idleThreshold = await getIdleThreshold();
  root.innerHTML = `
    <label for="token">Token API</label>
    <input id="token" type="password" placeholder="Colle ton token ici" />
    <button id="save">Enregistrer</button>
    ${idleThresholdFieldHtml(idleThreshold)}
  `;
  document.getElementById("save").addEventListener("click", async () => {
    const value = document.getElementById("token").value.trim();
    if (!value) return;
    await chrome.storage.local.set({ [TOKEN_KEY]: value });
    render();
  });
  bindIdleThresholdField();
}

async function renderStartForm(root, token) {
  root.innerHTML = `<div class="field">Chargement des listes...</div>`;

  let lists = [];
  let loadError = null;
  try {
    const res = await fetch(FOCUS_LISTS_API, {
      headers: { "Authorization": `Bearer ${token}` }
    });
    if (!res.ok) throw new Error("Erreur de chargement");
    lists = await res.json();
  } catch (err) {
    loadError = String(err.message || err);
  }

  if (loadError) {
    root.innerHTML = `<div class="error">${loadError}</div><button id="logout" class="secondary">Déconnecter</button>`;
    document.getElementById("logout").addEventListener("click", async () => {
      await chrome.storage.local.remove(TOKEN_KEY);
      render();
    });
    return;
  }

  if (!lists.length) {
    root.innerHTML = `
      <div class="field">Aucune FocusList. Crée-en une depuis le dashboard.</div>
      <button id="logout" class="secondary">Déconnecter</button>
    `;
    document.getElementById("logout").addEventListener("click", async () => {
      await chrome.storage.local.remove(TOKEN_KEY);
      render();
    });
    return;
  }

  root.innerHTML = `
    <div class="field">
      <label for="list">FocusList</label>
      <select id="list">
        ${lists.map((l) => `<option value="${l.id}">${l.name} (${l.type === "whitelist" ? "Whitelist" : "Blacklist"})</option>`).join("")}
      </select>
    </div>
    <div class="field">
      <label>Durée</label>
      <div class="durations" id="durations">
        ${DURATIONS.map((d) => `<div class="duration-pill${d === selectedDuration ? " selected" : ""}" data-duration="${d}">${d}m</div>`).join("")}
      </div>
    </div>
    <button id="start">Démarrer</button>
    <button id="logout" class="secondary">Déconnecter</button>
    ${idleThresholdFieldHtml(await getIdleThreshold())}
  `;

  document.querySelectorAll(".duration-pill").forEach((pill) => {
    pill.addEventListener("click", () => {
      selectedDuration = Number(pill.dataset.duration);
      document.querySelectorAll(".duration-pill").forEach((p) => p.classList.remove("selected"));
      pill.classList.add("selected");
    });
  });

  document.getElementById("start").addEventListener("click", async () => {
    const listId = document.getElementById("list").value;
    const list = lists.find((l) => String(l.id) === String(listId));
    const startBtn = document.getElementById("start");
    startBtn.disabled = true;
    startBtn.textContent = "Démarrage...";
    const response = await sendMessage({ type: "startFocusSession", list, durationMin: selectedDuration });
    if (response?.ok) {
      render();
    } else {
      startBtn.disabled = false;
      startBtn.textContent = "Démarrer";
      alert(response?.error || "Erreur au démarrage de la session");
    }
  });

  document.getElementById("logout").addEventListener("click", async () => {
    await chrome.storage.local.remove(TOKEN_KEY);
    render();
  });
  bindIdleThresholdField();
}

function renderActiveSession(root, state) {
  root.innerHTML = `
    <div class="session-card">
      <div class="session-list-name">${state.listName || "Session de focus"}</div>
      <div class="session-list-type">${state.listType === "whitelist" ? "Whitelist" : "Blacklist"}</div>
      <div class="timer" id="timer">--:--</div>
      <button id="abandon" class="danger">Débloquer (abandonner)</button>
    </div>
  `;

  const endAt = state.startedAt + state.durationMin * 60 * 1000;
  const tick = () => {
    const remaining = endAt - Date.now();
    document.getElementById("timer").textContent = formatRemaining(remaining);
    if (remaining <= 0) {
      stopTimer();
      render();
    }
  };
  tick();
  timerInterval = setInterval(tick, 1000);

  document.getElementById("abandon").addEventListener("click", async () => {
    stopTimer();
    await chrome.tabs.create({ url: chrome.runtime.getURL("friction.html") });
  });
}

async function render() {
  stopTimer();
  const root = document.getElementById("root");
  const { [TOKEN_KEY]: token } = await chrome.storage.local.get(TOKEN_KEY);

  if (!token) {
    await renderTokenForm(root);
    return;
  }

  const response = await sendMessage({ type: "getFocusSession" });
  const activeSession = response?.state || null;

  if (activeSession) {
    renderActiveSession(root, activeSession);
  } else {
    await renderStartForm(root, token);
  }
}

render();
