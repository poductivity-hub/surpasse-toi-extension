# Surpasse-Toi Tracker — Extension Chrome

Skeleton Manifest V3 qui mesure le temps passé par domaine et l'envoie au dashboard Surpasse-Toi.

## Structure

```
manifest.json    Manifest V3, permissions storage/idle/alarms/tabs + host_permissions <all_urls>
background.js    Service worker (module) : détection focus/idle, buffer journalier, flush
popup.html       UI minimale du popup (saisie token / déconnexion)
popup.js         Logique du popup, lit/écrit chrome.storage.local["apiToken"]
```

Pas de bundler, pas de build step — JS vanilla pour ce skeleton.

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

Domaines ignorés : tout ce qui n'est pas `http(s)` (les `chrome://`, `about:`, etc. sont filtrés par `extractDomain`) **et** `dashboard.surpassetoi.fr` (pour ne pas tracker l'usage du dashboard lui-même).

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

## Popup

- Si pas de token : champ + bouton "Enregistrer".
- Si token présent : "Connecté" + bouton "Déconnecter" (supprime `apiToken` du storage).
- Token stocké en clair dans `chrome.storage.local["apiToken"]` (acceptable pour ce skeleton).

## Charger en dev

1. `chrome://extensions`
2. Activer "Mode développeur" (toggle haut-droit)
3. "Charger l'extension non empaquetée" → sélectionner ce dossier
4. Ouvrir le popup, coller un token de test
5. Inspecter le service worker depuis la carte de l'extension pour voir les logs / réseau
