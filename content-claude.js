// Content script injecté sur claude.ai uniquement (voir manifest.json).
//
// But : claude.ai n'encode PAS l'identifiant du projet dans l'URL d'une
// conversation (URL = claude.ai/chat/{chatId}, identique quel que soit le
// projet). Le nom du projet n'est visible que dans l'interface (breadcrumb
// en haut de page). On le capte ici et on l'envoie au service worker, qui
// l'attache au payload de tracking quand le domaine actif est claude.ai.
//
// claude.ai est une SPA : pas de rechargement entre conversations. On réagit
// donc aux mutations du DOM (titre + breadcrumb) et aux changements d'URL via
// l'API History, pas uniquement au chargement initial.

(() => {
  // Log inconditionnel : confirmation que le script est bien injecté.
  console.log("[surpasse-toi] content-claude.js injecté sur", location.href);

  // Valeurs génériques qui ne sont PAS un nom de projet (ne jamais envoyer).
  const GENERIC = new Set(["claude", "claude.ai", "new chat", "nouvelle conversation"]);

  // Sélecteurs candidats pour le breadcrumb / nom de projet, essayés dans
  // l'ordre — on garde le premier qui donne un texte non vide et non générique.
  const BREADCRUMB_SELECTORS = [
    '[data-testid*="project" i]',
    '[data-testid*="breadcrumb" i]',
    'nav[aria-label*="breadcrumb" i]',
    'header nav',
    'header [class*="breadcrumb" i]',
  ];

  let lastSentLabel = null;

  function clean(s) {
    if (typeof s !== "string") return null;
    const t = s.trim();
    if (!t) return null;
    if (GENERIC.has(t.toLowerCase())) return null;
    return t;
  }

  // a) Breadcrumb / élément de navigation en haut de page.
  function detectFromBreadcrumb() {
    for (const sel of BREADCRUMB_SELECTORS) {
      let el;
      try {
        el = document.querySelector(sel);
      } catch {
        continue; // sélecteur invalide selon le moteur — on passe au suivant
      }
      if (!el) continue;
      const text = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (!text) continue;
      // Format breadcrumb "Projet / Conversation" → on prend le 1er segment
      // (le nom du projet) ; sinon le texte complet s'il est plausible.
      if (text.includes("/")) {
        const first = clean(text.split("/")[0]);
        if (first) {
          console.log("[surpasse-toi] tentative breadcrumb (sélecteur '" + sel + "'):", first);
          return first;
        }
      } else {
        const c = clean(text);
        if (c) {
          console.log("[surpasse-toi] tentative breadcrumb (sélecteur '" + sel + "'):", c);
          return c;
        }
      }
    }
    console.log("[surpasse-toi] tentative breadcrumb:", null);
    return null;
  }

  // b) Repli sur document.title (format type "Conversation - Projet" ou
  //    "Conversation | Projet"). On prend le dernier segment comme projet,
  //    en écartant les valeurs génériques ("Claude").
  function detectFromTitle() {
    const title = document.title || "";
    console.log("[surpasse-toi] tentative document.title:", title);
    const parts = title.split(/\s+[-|–]\s+/).map((p) => p.trim()).filter(Boolean);
    if (parts.length < 2) {
      console.log("[surpasse-toi] titre ne contient pas le séparateur attendu");
      return null;
    }
    const candidate = clean(parts[parts.length - 1]);
    return candidate;
  }

  // Cascade : breadcrumb → title → rien.
  function detectLabel() {
    const breadcrumb = detectFromBreadcrumb();
    if (breadcrumb) {
      console.log("[surpasse-toi] label final retenu (breadcrumb):", breadcrumb);
      return breadcrumb;
    }
    const title = detectFromTitle();
    if (title) {
      console.log("[surpasse-toi] label final retenu (title):", title);
      return title;
    }
    console.log("[surpasse-toi] label final retenu:", null);
    return null;
  }

  function detectAndSend() {
    const label = detectLabel();
    if (label === lastSentLabel) return; // n'envoie QUE si le label a changé
    lastSentLabel = label;
    console.log("[surpasse-toi] label projet Claude détecté :", label);
    try {
      chrome.runtime.sendMessage({ type: "claudeProjectLabel", label });
    } catch {
      // service worker endormi / contexte invalidé — sans gravité, on
      // renverra au prochain changement.
    }
  }

  // Débounce : le MutationObserver peut se déclencher très souvent (streaming
  // de tokens, etc.) — on ne lance la détection qu'au plus une fois / 500 ms.
  let debounceTimer = null;
  function scheduleDetect() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(detectAndSend, 500);
  }

  const observer = new MutationObserver(scheduleDetect);
  observer.observe(document.documentElement, { subtree: true, childList: true });

  // Changements de route SPA via l'API History (claude.ai ne recharge pas).
  const origPush = history.pushState;
  const origReplace = history.replaceState;
  history.pushState = function (...args) {
    const r = origPush.apply(this, args);
    scheduleDetect();
    return r;
  };
  history.replaceState = function (...args) {
    const r = origReplace.apply(this, args);
    scheduleDetect();
    return r;
  };
  window.addEventListener("popstate", scheduleDetect);

  // Détection initiale.
  detectAndSend();
})();
