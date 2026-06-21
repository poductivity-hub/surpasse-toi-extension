const FOCUS_SESSION_KEY = "activeFocusSession";

const TEXTS = {
  100: "Je choisis de ne pas abandonner. La discipline est la voix qui domine la voix qui supplie d'arrêter.",
  200: "Je choisis de ne pas abandonner maintenant. L'inconfort que je ressens n'est pas un signal de danger, c'est un signal de croissance. La voix qui me supplie d'arrêter n'est pas celle qui décide. C'est moi qui décide, et je continue.",
  300: "Je choisis de ne pas abandonner maintenant. L'inconfort que je ressens n'est pas un signal de danger, c'est un signal de croissance. La voix qui me supplie d'arrêter n'est pas celle qui décide. Personne ne viendra faire ce travail à ma place. La discipline n'est pas une punition, c'est la seule route vers la version de moi que je veux devenir. Je continue.",
  500: "Je choisis de ne pas abandonner maintenant. L'inconfort que je ressens n'est pas un signal de danger, c'est un signal de croissance. La voix qui me supplie d'arrêter n'est pas celle qui décide. Personne ne viendra faire ce travail à ma place, et personne ne le fera mieux que moi si je m'y refuse. La discipline n'est pas une punition, c'est la seule route vers la version de moi que je veux devenir. Le confort d'aujourd'hui est la dette de demain. Je préfère payer le prix maintenant, pendant que j'ai encore le choix. Je continue.",
  1000: "Je choisis de ne pas abandonner maintenant. L'inconfort que je ressens n'est pas un signal de danger, c'est un signal de croissance. La voix qui me supplie d'arrêter n'est pas celle qui décide. Personne ne viendra faire ce travail à ma place, et personne ne le fera mieux que moi si je m'y refuse. La discipline n'est pas une punition, c'est la seule route vers la version de moi que je veux devenir. Le confort d'aujourd'hui est la dette de demain. Je préfère payer le prix maintenant, pendant que j'ai encore le choix. La plupart des gens s'arrêtent exactement au moment où l'effort commence à compter. C'est précisément cet instant qui sépare ceux qui progressent de ceux qui stagnent. Je n'ai pas besoin de me sentir motivé pour continuer, j'ai seulement besoin de continuer. La motivation suit l'action, elle ne la précède pas. Je referme cette porte de sortie, parce que je sais qu'elle ne mène nulle part qui vaille la peine. Je continue.",
  2000: "Je choisis de ne pas abandonner maintenant. L'inconfort que je ressens n'est pas un signal de danger, c'est un signal de croissance. La voix qui me supplie d'arrêter n'est pas celle qui décide. Personne ne viendra faire ce travail à ma place, et personne ne le fera mieux que moi si je m'y refuse. La discipline n'est pas une punition, c'est la seule route vers la version de moi que je veux devenir. Le confort d'aujourd'hui est la dette de demain. Je préfère payer le prix maintenant, pendant que j'ai encore le choix. La plupart des gens s'arrêtent exactement au moment où l'effort commence à compter. C'est précisément cet instant qui sépare ceux qui progressent de ceux qui stagnent. Je n'ai pas besoin de me sentir motivé pour continuer, j'ai seulement besoin de continuer. La motivation suit l'action, elle ne la précède pas. Je referme cette porte de sortie, parce que je sais qu'elle ne mène nulle part qui vaille la peine. Mon esprit négociera, cherchera des excuses raisonnables, habillera la faiblesse en sagesse. Je ne l'écoute pas. Le seul juge qui compte, c'est la personne que je serai dans six mois, et elle me regarde agir maintenant. Chaque fois que je tiens alors que tout en moi veut lâcher, je deviens un peu plus la personne capable de tenir la prochaine fois. C'est ainsi que se construit une vie : pas par un grand moment héroïque, mais par cette décision répétée, encore et encore, de rester. Je continue."
};

function pickText(frictionChars) {
  const tiers = [100, 200, 300, 500, 1000, 2000];
  let chosen = tiers[0];
  for (const t of tiers) {
    if (frictionChars >= t) chosen = t;
  }
  return TEXTS[chosen];
}

async function endFocusSession() {
  const { [FOCUS_SESSION_KEY]: state } = await chrome.storage.local.get(FOCUS_SESSION_KEY);
  await chrome.runtime.sendMessage({ type: "endFocusSession", abandoned: true });
  return state;
}

function showStep(id) {
  document.querySelectorAll(".step").forEach((el) => el.classList.remove("active"));
  document.getElementById(id).classList.add("active");
}

function setupCharsStep(state, onDone) {
  const imposed = pickText(state.frictionChars || 0);
  document.getElementById("imposedText").textContent = imposed;
  const textarea = document.getElementById("typed");
  const counter = document.getElementById("counter");
  const confirmBtn = document.getElementById("confirmChars");

  ["copy", "paste", "cut"].forEach((evt) => {
    textarea.addEventListener(evt, (e) => e.preventDefault());
  });

  textarea.addEventListener("input", () => {
    const typed = textarea.value;
    counter.textContent = `${typed.length} / ${imposed.length}`;
    const matches = typed === imposed;
    counter.classList.toggle("ok", matches);
    confirmBtn.disabled = !matches;
  });

  confirmBtn.addEventListener("click", () => {
    if (textarea.value !== imposed) return;
    onDone();
  });

  counter.textContent = `0 / ${imposed.length}`;
  showStep("step-chars");
}

function setupDelayStep(state, onDone, onCancel) {
  const delayMs = (state.frictionDelay || 0) * 60 * 1000;
  const endAt = Date.now() + delayMs;
  const countdownEl = document.getElementById("countdown");
  const unlockBtn = document.getElementById("unlockNow");
  const cancelBtn = document.getElementById("cancelDelay");

  let interval = null;

  function format(ms) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  function tick() {
    const remaining = endAt - Date.now();
    countdownEl.textContent = format(remaining);
    if (remaining <= 0) {
      clearInterval(interval);
      unlockBtn.disabled = false;
    }
  }
  tick();
  interval = setInterval(tick, 1000);

  unlockBtn.addEventListener("click", () => {
    if (unlockBtn.disabled) return;
    clearInterval(interval);
    onDone();
  });

  cancelBtn.addEventListener("click", () => {
    clearInterval(interval);
    onCancel();
  });

  showStep("step-delay");
}

function setupConfirmStep(onConfirm, onCancel) {
  document.getElementById("confirmAbandon").addEventListener("click", onConfirm);
  document.getElementById("cancelAll").addEventListener("click", onCancel);
  showStep("step-confirm");
}

async function init() {
  const { [FOCUS_SESSION_KEY]: state } = await chrome.storage.local.get(FOCUS_SESSION_KEY);
  if (!state) {
    document.body.innerHTML = "<p>Aucune session active.</p>";
    return;
  }

  const cancel = () => window.close();

  const confirmAndClose = () => {
    setupConfirmStep(
      async () => {
        await endFocusSession();
        window.close();
      },
      cancel
    );
  };

  const startDelayOrConfirm = () => {
    if (state.frictionDelay > 0) {
      setupDelayStep(state, confirmAndClose, cancel);
    } else {
      confirmAndClose();
    }
  };

  if (state.frictionChars > 0) {
    setupCharsStep(state, startDelayOrConfirm);
  } else {
    startDelayOrConfirm();
  }
}

init();
