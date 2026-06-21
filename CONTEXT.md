# Surpasse-Toi Tracker — Extension Chrome

Extension Manifest V3 qui (1) mesure le temps passé par domaine et l'envoie au dashboard Surpasse-Toi, et (2) permet de lancer des sessions de focus qui bloquent des sites via `declarativeNetRequest`, avec une friction volontaire pour abandonner en cours de route.

## Structure

```
manifest.json    Manifest V3 : permissions storage/idle/alarms/tabs/declarativeNetRequest(+WithHostAccess),
                 host_permissions <all_urls>, declarative_net_request.rule_resources (rules.json, désactivé par défaut)
rules.json       Règles statiques DNR — vide, tout le blocage se fait via règles dynamiques
background.js    Service worker (module) : tracking focus/idle + logique de session de focus (DNR, alarms, API)
popup.html/js    UI du popup, 2 états : formulaire de démarrage de session / session active avec timer
friction.html/js Page ouverte dans un nouvel onglet pour abandonner une session (recopie de texte + délai)
```

Pas de bundler, pas de build step — JS vanilla.

## Contrat API (en prod, ne pas modifier)

`POST https://dashboard.surpassetoi.fr/api/extension/track`

Headers :
- `Authorization: Bearer <token>`
- `Content-Type: application/json`

Body :
```json
{ "domain": "example.com", "durationSeconds": 123, "date": "2026-06-21" }
```

Réponses :
- `200 { "ok": true }` → succès, on retire l'entrée du buffer
- `401` → token invalide, on garde le buffer pour retry
- erreur réseau / 5xx → on garde le buffer

## Logique de détection focus / idle

Un "segment de tracking actif" n'existe que si **toutes** les conditions sont vraies :
1. La fenêtre Chrome a le focus OS (`chrome.windows.onFocusChanged` ≠ `WINDOW_ID_NONE`)
2. L'onglet actif a une URL `http(s)` valide
3. L'utilisateur n'est pas idle (`chrome.idle`, seuil 60 s)

État en mémoire dans le service worker :
- `activeDomain: string | null`
- `segmentStartedAt: number | null` (timestamp ms)
- `windowFocused: boolean`
- `userIdle: boolean`

Listeners :
- `chrome.tabs.onActivated` — changement d'onglet
- `chrome.tabs.onUpdated` — changement d'URL dans l'onglet actif (filtre `changeInfo.url` + `tab.active`)
- `chrome.windows.onFocusChanged` — focus OS
- `chrome.idle.onStateChanged` — idle / locked / active

À chaque évènement pertinent :
1. Si un segment était en cours → calcule la durée, l'ajoute au buffer.
2. Si les conditions sont à nouveau réunies → démarre un nouveau segment.
3. Sinon → `activeDomain = null`.

Domaines ignorés : uniquement les schémas non `http(s)` (`chrome://`, `chrome-extension://`, `about:`, `edge://`, etc. — pages internes du navigateur sans domaine HTTP valide, filtrées par `extractDomain`). `dashboard.surpassetoi.fr` est trackée comme n'importe quel autre domaine.

## Buffer local

Stocké dans `chrome.storage.local` sous la clé `trackingBuffer` :

```json
{
  "2026-06-21": {
    "youtube.com": 1834,
    "github.com": 612
  },
  "2026-06-22": {
    "linkedin.com": 240
  }
}
```

- Indexé par date `YYYY-MM-DD` (date locale du début de segment), puis par domaine.
- Valeur = durée cumulée en secondes depuis le dernier flush réussi pour ce (date, domaine).

## Flush périodique

`chrome.alarms` toutes les 60 s (`FLUSH_ALARM`) :
1. Termine le segment en cours (l'ajoute au buffer) pour ne rien perdre.
2. Lit le token (`apiToken`). Si absent : ne rien envoyer, garder le buffer.
3. Pour chaque (date, domaine) avec total > 0 : `POST /api/extension/track`.
4. Si `200` → retire l'entrée du buffer.
5. Sinon → garde le buffer, retry au prochain alarm.
6. Relance un segment frais si les conditions sont toujours réunies.

## Sessions de focus (blocage de sites)

### Contrat API

`GET /api/focus-lists` → `[{ id, name, type, domains, frictionType, frictionChars, frictionDelay }]`
(`type` = `"blacklist"` ou `"whitelist"`)

`POST /api/focus-sessions` body `{ focusListId, durationMin }` → `{ id }`

`PATCH /api/focus-sessions` body `{ id, endedAt?, abandoned?, abandonCount? }`

### État

`chrome.storage.local["activeFocusSession"]` : `{ sessionId, focusListId, listName, listType,
domains, durationMin, startedAt, frictionType, frictionChars, frictionDelay, abandonCount } | absent`

### Démarrage (`startFocusSession`, dans `background.js`)

1. `POST /api/focus-sessions` → récupère `sessionId`.
2. Construit les règles `declarativeNetRequest` dynamiques selon `type` :
   - `blacklist` : une règle `block` par domaine listé (`urlFilter: "||domaine"`, `main_frame`).
   - `whitelist` : une règle `allow` (priorité 2) par domaine listé + une règle `block` (priorité 1,
     id `1000`) qui matche tout (`urlFilter: "*"`).
3. Remplace les règles dynamiques existantes (`clearDynamicRules` puis `updateDynamicRules`).
4. Stocke l'état dans `chrome.storage.local`.
5. Programme `chrome.alarms.create("focusEnd", { delayInMinutes: durationMin })`.

### Fin (`endFocusSession(abandoned)`, dans `background.js`)

1. Supprime toutes les règles dynamiques DNR.
2. Annule l'alarme `focusEnd`.
3. `PATCH /api/focus-sessions` avec `endedAt`, `abandoned`, et `abandonCount` incrémenté si abandon.
4. Nettoie `activeFocusSession` du storage.

L'alarme `focusEnd` déclenche `endFocusSession(false)` (fin naturelle, pas un abandon).

Messages écoutés par le service worker (`chrome.runtime.onMessage`) : `startFocusSession`,
`endFocusSession`, `getFocusSession` (lecture de l'état courant, utilisée par le popup).

## Popup

Deux états, déterminés par la présence d'un token et d'une session active (`getFocusSession`) :

- **Pas de token** : champ + bouton "Enregistrer" (comportement historique).
- **Token présent, pas de session active** : liste déroulante des FocusList (`GET /api/focus-lists`),
  pastilles de durée (15/30/45/60/75/90/120 min), bouton "Démarrer" → message `startFocusSession`.
- **Session active** : nom + type de la liste, timer décompte (recalculé chaque seconde depuis
  `startedAt + durationMin`), bouton "Terminer la session" (`endFocusSession` non abandonné) et
  bouton "Débloquer (abandonner)" qui ouvre `friction.html` dans un nouvel onglet.

Token stocké en clair dans `chrome.storage.local["apiToken"]` (acceptable pour ce skeleton).

## Page de friction (`friction.html` / `friction.js`)

Ouverte dans un nouvel onglet, lit `activeFocusSession` depuis le storage. Étapes séquentielles :

1. **Recopie de texte** (si `frictionChars > 0`) : un texte imposé (ton discipline/Goggins, choisi
   selon le palier le plus proche ≤ `frictionChars` parmi 100/200/300/500/1000/2000) doit être recopié
   à l'identique dans un textarea. Copier/coller/couper désactivés (`preventDefault` sur les events
   clipboard). Le bouton "Continuer" ne s'active qu'en cas de correspondance stricte.
2. **Délai** (si `frictionDelay > 0`) : compte à rebours de `frictionDelay` minutes. Bouton "Annuler"
   pour revenir en arrière sans débloquer ; "Débloquer maintenant" s'active à la fin du délai.
3. **Confirmation** : bouton "Confirmer l'abandon" → message `endFocusSession` avec `abandoned: true`
   (le service worker incrémente `abandonCount` et fait le `PATCH`), puis l'onglet se ferme.

Si ni `frictionChars` ni `frictionDelay` ne sont définis, la page passe directement à la confirmation.

## Charger en dev

1. `chrome://extensions`
2. Activer "Mode développeur" (toggle haut-droit)
3. "Charger l'extension non empaquetée" → sélectionner ce dossier
4. Ouvrir le popup, coller un token de test
5. Inspecter le service worker depuis la carte de l'extension pour voir les logs / réseau
