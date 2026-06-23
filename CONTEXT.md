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
{ "domain": "example.com", "path": "/project/abc123", "durationSeconds": 123, "date": "2026-06-21" }
```

- `path` (ajouté le 2026-06-22) : optionnel, omis entièrement si absent — **jamais** envoyé comme chaîne vide. Toujours `new URL(tab.url).pathname` uniquement, jamais la query string (`?...`) ni le fragment (`#...`) — confidentialité (pas de termes de recherche ni de paramètres sensibles transmis). `null`/absent si le pathname n'est pas significatif (vide ou `"/"`). Permet au dashboard de distinguer plusieurs projets sur un même domaine (ex. deux Projects Claude différents sur `claude.ai`).

Réponses :
- `200 { "ok": true }` → succès, on retire l'entrée du buffer
- `401` → token invalide, on garde le buffer pour retry
- erreur réseau / 5xx → on garde le buffer

## Logique de détection focus / idle

Un "segment de tracking actif" n'existe que si **toutes** les conditions sont vraies :
1. La fenêtre Chrome a le focus OS (`chrome.windows.onFocusChanged` ≠ `WINDOW_ID_NONE`)
2. L'onglet actif a une URL `http(s)` valide
3. L'utilisateur n'est pas idle (`chrome.idle`, seuil configurable, 60 s par défaut) — **sauf** si l'onglet actif joue un média audible (voir plus bas)

État en mémoire dans le service worker :
- `activeDomain: string | null`
- `activePath: string | null` (pathname uniquement, `extractPath()` — ajouté le 2026-06-22)
- `segmentStartedAt: number | null` (timestamp ms)
- `windowFocused: boolean`
- `userIdle: boolean`

`activeDomain`/`activePath`/`segmentStartedAt` sont en plus **mirrorés** dans `chrome.storage.local["activeSegment"]` pour survivre à un kill du service worker (voir "Persistance du segment en cours" plus bas).

Listeners :
- `chrome.tabs.onActivated` — changement d'onglet
- `chrome.tabs.onUpdated` — changement d'URL dans l'onglet actif (filtre `changeInfo.url` + `tab.active`)
- `chrome.windows.onFocusChanged` — focus OS
- `chrome.idle.onStateChanged` — idle / locked / active

À chaque évènement pertinent :
1. Si un segment était en cours → calcule la durée, l'ajoute au buffer.
2. Si les conditions sont à nouveau réunies → démarre un nouveau segment.
3. Sinon → `activeDomain = null`.

**Déduplication multi-onglets/fenêtres** : l'état est constitué de singletons globaux (`activeDomain`/`activePath`/`segmentStartedAt`) — il ne peut donc structurellement exister qu'**un seul segment actif à la fois**. Tous les listeners passent par `recomputeActiveSegment()`, qui `flushSegmentIfAny()` (clôture et crédite le segment précédent) **avant** de démarrer le nouveau. Le tracking par `path` ne crée pas de parallélisme : le flush ferme l'ancien couple `(domaine, path)` avant que le nouveau path soit posé.

**Revérification live à l'ouverture d'un segment (ajouté le 2026-06-22, suite à audit)** : le service worker MV3 peut être terminé par Chrome après ~30 s d'inactivité. À son réveil (sur un évènement quelconque), les variables en mémoire `windowFocused`/`userIdle` repartent sur leurs valeurs par défaut (`true`/`false`) — permissives et potentiellement fausses si l'utilisateur était en réalité absent ou sur une autre fenêtre au moment du réveil. Deux filets de sécurité, qui s'ajoutent aux listeners existants sans les remplacer :
1. `recomputeActiveSegment()` n'ouvre un nouveau segment qu'après confirmation **live** via `isReallyActiveNow()` : `chrome.idle.queryState(IDLE_THRESHOLD_SECONDS) === "active"` **ET** `chrome.windows.getLastFocused({ windowTypes: ["normal"] })` avec une fenêtre non `WINDOW_ID_NONE` et `focused === true`.
2. `syncFocusAndIdleState()`, appelée dans `onInstalled`/`onStartup`, recale `windowFocused`/`userIdle` sur l'état réel dès le démarrage du service worker plutôt que de partir sur les valeurs en dur.

Les listeners `onFocusChanged`/`onActivated`/`onStateChanged` restent la voie rapide pour la réactivité immédiate ; cette double vérification ne fait que combler l'angle mort du redémarrage du SW. N'affecte pas `MAX_SEGMENT_MS` ni la logique de flush.

**Seuil d'inactivité (retiré du popup le 2026-06-23)** : le seuil avait brièvement été rendu configurable via un champ du popup, mais c'était trop fin pour un usage normal — retiré. Le seuil est de nouveau une constante codée en dur (`IDLE_THRESHOLD_SECONDS = 60` dans `background.js`), utilisée par `chrome.idle.setDetectionInterval()` et par les deux appels à `chrome.idle.queryState()` (`syncFocusAndIdleState`, `isReallyActiveNow`).

**Persistance du segment en cours (ajouté le 2026-06-23)** : le segment actif (`activeDomain`/`activePath`/`segmentStartedAt`) vivait auparavant **uniquement en variable JS en mémoire**. Le service worker MV3 pouvant être tué par Chrome à tout moment après ~30 s sans évènement, un kill survenant **pendant** un segment de navigation active faisait perdre tout le temps écoulé depuis `segmentStartedAt` (au réveil, `segmentStartedAt` repartait à `null`, donc `flushSegmentIfAny()` ne créditait rien). Correctif :
- À chaque démarrage de segment, `recomputeActiveSegment()` écrit un **miroir persistant** dans `chrome.storage.local["activeSegment"]` : `{ domain, path, startedAt }`. `flushSegmentIfAny()` le retire dès que le segment est clos normalement.
- `recoverOrphanSegment()` lit ce miroir au réveil du service worker (en tête de `recomputeActiveSegment()`, en tête du handler du flush alarm, et dans `onInstalled`/`onStartup`). Si un segment orphelin existe, il est crédité au buffer journalier exactement comme un flush normal, via le helper partagé `creditSegmentToBuffer()` — **avant** qu'un nouveau segment ne démarre.
- **Pas de double comptage** : `recoverOrphanSegment()` ne fait rien si un segment est déjà actif en mémoire (le SW est vivant → le flush normal s'en charge), et retire le miroir avant de créditer. Le miroir reflète toujours soit le segment en mémoire courant, soit rien — jamais deux segments distincts.
- **Cohérence avec l'anti-veille** : la récupération passe par le même `creditSegmentToBuffer()`, donc le cap `MAX_SEGMENT_MS` (90 s) s'applique. Si le kill du SW a coïncidé avec une mise en veille de la machine, l'écart dépasse 90 s et **rien n'est crédité** (comportement correct, identique au flush normal). Un segment légitime tué entre deux flushs (≤ ~60 s) est lui correctement récupéré.

**Maintien du tracking pendant lecture média (ajouté le 2026-06-23)** : `chrome.idle` se base uniquement sur l'activité clavier/souris/écran — un utilisateur qui regarde une vidéo ou écoute un podcast sans toucher la souris serait à tort détecté comme idle et verrait son segment coupé. `recomputeActiveSegment()` interroge donc `chrome.tabs.query({ active: true, lastFocusedWindow: true })` et regarde la propriété `audible` de l'onglet actif (`isActiveTabAudible()`) :
- `audible === true` → ignore l'état idle (à la fois `userIdle` du listener et la revérification live `isReallyActiveNow()`) ; le segment continue/redémarre normalement. Le focus fenêtre (`windowFocused`) reste, lui, requis sans exception.
- `audible === false` → comportement inchangé : idle coupe le segment.

**claude.ai — assignation manuelle uniquement** : claude.ai n'encode pas le projet dans l'URL (`claude.ai/chat/{chatId}` est identique quel que soit le projet). Une tentative d'auto-détection du projet via content script (fichier `content-claude.js`) a été **abandonnée le 2026-06-22** — le DOM de claude.ai est trop fragile à cibler sans exécution réelle du navigateur, et les sélecteurs ne survivent pas aux mises à jour. Il n'existe donc **aucun fichier content script** dans l'extension. claude.ai est matchée par domaine seul et apparaît comme "Non assigné" par défaut sauf configuration manuelle (WorkContext avec entrée domaine+chemin, ex. `claude.ai/project/abc123`, côté dashboard).

Domaines ignorés : uniquement les schémas non `http(s)` (`chrome://`, `chrome-extension://`, `about:`, `edge://`, etc. — pages internes du navigateur sans domaine HTTP valide, filtrées par `extractDomain`). `dashboard.surpassetoi.fr` est trackée comme n'importe quel autre domaine.

## Anti-veille / anti-sur-comptage (ajouté le 2026-06-22)

**Problème corrigé** : pendant une mise en veille de l'OS, le processus est *gelé* (RAM conservée) donc `segmentStartedAt` survit, mais le flush alarm ne tourne pas. Au réveil, le premier flush calculait `now - segmentStartedAt` = **toute la durée de la veille** et la créditait au dernier domaine actif (symptôme observé : 16 h 55 affichées à 13 h 31). La détection `chrome.idle` (60 s) ne couvre que le cas « machine éveillée mais utilisateur absent », pas une veille brutale.

Trois garde-fous :
1. **Cap par segment** (`MAX_SEGMENT_MS = 90 s`) dans `flushSegmentIfAny()` : un segment légitime ne dépasse jamais ~60 s (intervalle du flush alarm qui redémarre un segment frais à chaque passage) ; 90 s laisse une marge. Tout segment plus long est un « trou » de veille/suspension → **aucun temps crédité**, on repart sur un segment neuf. C'est le correctif central.
2. **Détection idle** (`chrome.idle.onStateChanged`, seuil 60 s) : `idle`/`locked` mettent `userIdle = true` ; aucun nouveau segment ne démarre tant que l'utilisateur est inactif.
3. **Fil d'alarme de validation** (`auditDailyTotals`, appelé en tête de `sendBuffer`) : si le total cumulé d'aujourd'hui dépasse le temps écoulé depuis minuit local (+120 s de marge), un `console.warn` est émis. Non bloquant (le cap empêche déjà l'accumulation aberrante ; bloquer risquerait de droper une journée légitime sur un faux positif).

## Buffer local

Stocké dans `chrome.storage.local` sous la clé `trackingBuffer` :

```json
{
  "2026-06-21": {
    "youtube.com": { "": 1834 },
    "github.com": { "": 400, "/org/repo": 212 },
    "claude.ai": { "/project/abc123": 900, "/project/xyz789": 300 }
  },
  "2026-06-22": {
    "linkedin.com": { "": 240 }
  }
}
```

- Indexé par date `YYYY-MM-DD` (date locale du début de segment), puis par domaine, puis par **chemin** (`pathKey`, ajouté le 2026-06-22) — `pathKey` est le pathname réel (ex. `"/project/abc123"`) ou `""` (chaîne vide) pour "pas de chemin significatif".
- Valeur = durée cumulée en secondes depuis le dernier flush réussi pour ce (date, domaine, chemin).
- **Rétrocompatibilité** : si `buffer[date][domain]` est encore un nombre direct (ancien format, avant l'ajout du path), `migrateDomainEntry()` le convertit à la volée en `{ "": ancienneValeur }` au premier flush ou envoi — aucune perte de données pour les buffers en attente lors de la mise à jour de l'extension.

## Flush périodique

`chrome.alarms` toutes les 60 s (`FLUSH_ALARM`) :
1. Termine le segment en cours (l'ajoute au buffer) pour ne rien perdre.
2. Lit le token (`apiToken`). Si absent : ne rien envoyer, garder le buffer.
3. Pour chaque (date, domaine, chemin) avec total > 0 : `POST /api/extension/track`, avec `path` inclus dans le body uniquement si `pathKey` n'est pas vide.
4. Si `200` → retire l'entrée du buffer.
5. Sinon → garde le buffer, retry au prochain alarm.
6. Relance un segment frais si les conditions sont toujours réunies.

## Sessions de focus (blocage de sites)

### Contrat API

`GET /api/extension/focus-lists` → `[{ id, name, type, domains, frictionType, frictionChars, frictionDelay }]`
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
