# STC — Sous-titrage collaboratif + HLS (live + différé)

STC est une plateforme de sous-titrage collaboratif en temps réel, construite autour de :
- **un serveur Node/Express** (API + génération HLS via FFmpeg)
- **un WebSocket** (coordination temps réel admin/sous-titreurs/spectateurs)
- **trois interfaces web** : admin, sous-titreur, spectateur

Le point clé du projet : les **sous-titreurs travaillent sur le “live edge”** (playlist HLS live), tandis que les **spectateurs consomment un flux HLS “retardé”** (playlist recalculée) afin que les sous-titres soient disponibles au moment où ils regardent.

---

## Lancer le projet

### Via Docker (recommandé)
```bash
docker compose up --build
```
- Service web exposé sur `http://localhost:3001`
- Pages :
  - `/admin.html`
  - `/subtitler.html`
  - `/spectator.html`

### Sans Docker
Dans `web/` :
```bash
npm install
npm start
```
Le serveur écoute sur `PORT` (par défaut `3000`).

---

## Architecture (vue d’ensemble)

### Flux d’exécution global

```text
┌───────────────────────┐
│ docker-compose / node │
└───────────┬───────────┘
            │
            ▼
┌─────────────────────────────┐
│ src/server.js (entrypoint)  │
│ - init dirs                 │
│ - express static + routes   │
│ - websocket /ws             │
└───────────┬─────────────────┘
            │
   ┌────────┴───────────┐
   │                    │
   ▼                    ▼
┌──────────────┐  ┌─────────────────┐
│ src/routes.js│  │ src/websocket.js│
│ HTTP API +   │  │ WS temps réel   │
│ playlists HLS│  │ (admin/sub/...) │
└──────┬───────┘  └────────┬────────┘
       │                   │
       └──────────┬────────┘
                  ▼
         ┌──────────────────┐
         │ src/services.js   │
         │ - FFmpeg/HLS      │
         │ - delay playlist  │
         │ - fragmentation   │
         │ - fusion captions │
         └──────────────────┘
                  ▲
                  │
         ┌──────────────────┐
         │ src/core.js       │
         │ config + state    │
         └──────────────────┘
```

### Les 3 rôles
- **Admin** : choisit une vidéo, règle paramètres (delay, slot, overlap, grace…), démarre/arrête le live.
- **Sous-titreur** : regarde le flux HLS *live* et envoie des captions via WebSocket.
- **Spectateur** : regarde le flux HLS *retardé* et reçoit les sous-titres (mot par mot) déjà synchronisés.

---

## HLS : live vs “delay différé”

### 1) Génération HLS (FFmpeg)
Quand l’admin lance le live (`POST /api/live/start`) :
1. le serveur vide `public/hls/`
2. démarre **FFmpeg** avec un transcodage HLS
3. FFmpeg écrit :
   - `public/hls/stream.m3u8`
   - `public/hls/seg00001.ts`, `seg00002.ts`, …

Paramètres importants (dans `src/core.js` / `src/services.js`) :
- `segmentDuration = 2s`
- `-hls_list_size 0` (playlist “infinie” côté disque)
- `-hls_flags independent_segments+temp_file`

### 2) Playlist live (pour sous-titreurs)
Endpoint :
- `GET /hls/live.m3u8`

Ce que fait le serveur :
- lit `stream.m3u8`
- garde **la fenêtre la plus récente** (tail) de taille `hlsListSize` (par défaut 10 segments)
- renvoie une playlist “glissante” vers le live edge

### 3) Playlist “delayed” (pour spectateurs)
Endpoint :
- `GET /hls/delayed.m3u8`

Principe : le serveur ne “retranscode” pas, il **recalcule la playlist** pour qu’elle pointe vers des segments plus anciens.

Implémentation (dans `src/services.js`) :
- parse `#EXT-X-TARGETDURATION` et `#EXT-X-MEDIA-SEQUENCE`
- calcule un nombre de segments de retard :

$$
\text{delaySegs} = \left\lfloor \frac{delaySec}{targetDuration} \right\rfloor
$$

- prend une fenêtre de segments qui se termine à `segments.length - delaySegs`

Conséquences :
- le “delay” est **quantifié** au `targetDuration` (≈ 2s)
- si le live vient de démarrer et qu’il n’y a pas assez de segments, `/hls/delayed.m3u8` renvoie `Not enough segments`.

### 4) Buffering côté client (Hls.js)
Les pages `subtitler.html` et `spectator.html` utilisent `HlsPlayerManager` (dans `public/js/shared.js`) avec des options live :
- `liveSyncDurationCount: 3`
- `liveMaxLatencyDurationCount: 6`

Donc même la playlist “live” et “delayed” peuvent avoir **un buffer** additionnel côté lecteur.

Important : dans `public/js/spectator.js`, le code considère que le `delaySec` *inclut* déjà un buffering HLS (~ quelques segments).

---

## Workflow global du sous-titrage collaboratif

`Fragmentation` : les sous-titreurs se relaient sur des **slots** temporels avec **chevauchement**, puis le serveur **fusionne** les textes en supprimant les répétitions.

### Schéma :

```text
(1) Admin
    ├─ upload vidéo  -> POST /api/upload
    ├─ start live    -> POST /api/live/start {source, delaySec, slotDuration, overlap, grace, requiredSubtitlers}
    └─ observe état  -> WS 'fragment:admin-status' + GET /api/live/status

(2) Sous-titreurs
    ├─ ouvrent /subtitler.html
    ├─ WS identify + join
    ├─ lisent HLS live: GET /hls/live.m3u8
    └─ envoient captions -> WS {type:'caption', text, subtitlerName}

(3) Serveur
    ├─ schedule slots (rotation) toutes les (slotDuration - overlap)
    ├─ accepte captions uniquement pendant la fenêtre du slot
    ├─ auto-send à la fin (grace) si besoin
    ├─ fusion (overlap) entre slot N-1 et N
    └─ envoie au spectateur mot-par-mot au bon moment

(4) Spectateurs
    ├─ ouvrent /spectator.html
    ├─ lisent HLS delayed: GET /hls/delayed.m3u8
    └─ affichent 'caption:word' dès réception
```

### Timeline (slot, chevauchement, délai)

Notations :
- `slotDuration = D`
- `overlap = O`
- `stride = D - O` (début des slots)
- `grace = floor(D * gracePercent / 100)`

```text
Temps (serveur)

Slot 0 : [0 ------------------- D] + [grace]
Slot 1 :         [stride ----------- stride + D] + [grace]
Slot 2 :                 [2*stride ----- 2*stride + D] + [grace]

Fusion :
- on compare FIN(slot 0) avec DEBUT(slot 1)
- on stocke overlapFromPrev sur slot 1
- on envoie slot 0 une fois slot 1 est fini (ou slot 0 immédiatement si c’est le 1er)

Spectateur :
- voit la vidéo avec un délai `delaySec`
- reçoit les mots du slot N planifiés vers : slot.startTime + delaySec
```

### Pourquoi il faut un délai minimum
Dans `src/services.js`, le serveur impose un délai minimal pour éviter un paradoxe :
- le spectateur doit rester **derrière** le moment en train d’être sous-titré
- or en mode fragmentation, le texte “final” n’est disponible **qu’à la fin du slot + grace**

Donc :
- `minDelay = max(segmentDuration, slotDuration + grace)`
- si l’admin met un délai plus petit, l’API refuse (`POST /api/delay` et `POST /api/live/start`).

### Envoi “mot par mot” aux spectateurs
En mode fragmentation, après fusion, le serveur envoie `caption:word` :
- il découpe le texte final en mots
- répartit l’affichage sur `slotDuration` (intervalle = `slotDurationMs / nbMots`)
- planifie le début sur `slot.startTime + delaySec`

Le client spectateur :
- regroupe les mots par `caption.id`
- construit l’affichage progressivement

---

## Protocoles : HTTP + WebSocket

### HTTP (routes principales)
- `GET /api/live/status` : statut live + segments + delay + mode
- `POST /api/live/start` : démarre FFmpeg + (optionnel) fragment mode auto
- `POST /api/live/stop` : stop
- `GET /hls/live.m3u8` : playlist glissante live edge
- `GET /hls/delayed.m3u8` : playlist glissante retardée
- `GET /hls/*.ts` : segments

### WebSocket (`/ws`)
**Identify** (client → serveur)
```json
{ "type": "identify", "clientType": "admin|subtitler|spectator", "name": "..." }
```

**Init** (serveur → client)
```json
{ "type": "init", "odId": "...", "running": true, "delaySec": 20, "mode": "fragmentation", "fragmentMode": true }
```

**Fragment status** (serveur → sous-titreur)
- `fragment:status` : statut global + champs personnalisés (`isMyTurn`, `secondsRemaining`, `inGracePeriod`)
- `fragment:prepare`, `fragment:ending`, `fragment:grace-start`, `fragment:auto-send`

**Captions**
- sous-titreur → serveur : `{type:'caption', text, subtitlerName, autoSent?}`
- serveur → spectateur : `caption:word` (format mot par mot)

---

## Guide dev

### Racine
- `docker-compose.yml` : build/lancement du service `web` + volumes
  - `hls-data` monte `web/public/hls` (segments persistants dans volume)
  - `media-data` monte `web/media` (vidéos uploadées)

### `web/` (app Node + front statique)
- `web/Dockerfile` : image Node 18 + FFmpeg + lancement `node src/server.js`
- `web/package.json` : dépendances (express, ws, multer, hls.js)

### `web/src/` (serveur)
- `web/src/server.js`
  - entrypoint
  - initialise dossiers `media/` et `public/hls/`
  - configure express (static `public/`, static `/media`)
  - installe `routes.js`
  - démarre le WebSocket (`/ws`) via `websocket.js`

- `web/src/core.js`
  - **config** (port, répertoires, HLS, FFmpeg, fragmentation)
  - **state global** (ffmpegProc, liveStartedAt, delaySec, fragment session)
  - helpers (logs, isLiveRunning, getLiveTimestamp, reset timers)

- `web/src/routes.js`
  - API REST (config, delay, videos, upload, live status/start/stop)
  - endpoints HLS : `/hls/live.m3u8` et `/hls/delayed.m3u8`
  - static `/hls/*.ts` avec bons headers

- `web/src/websocket.js`
  - serveur WS
  - identification des clients
  - join/leave sous-titreurs
  - réception des captions et dispatch (fragment vs non-fragment)

- `web/src/services.js`
  - couche “métier” :
    - gestion FFmpeg (start/stop)
    - lecture/parse/build playlists m3u8
    - delay playlist
    - planification des slots (scheduler)
    - validation des fenêtres de saisie
    - fusion des slots (overlap)
    - diffusion des captions aux spectateurs (mot par mot)

### `web/public/` (front)
- `web/public/index.html` : page d’entrée (liens)
- `web/public/admin.html` : UI admin (start/stop + config + upload)
- `web/public/subtitler.html` : UI sous-titreur (login + vidéo live + saisie)
- `web/public/spectator.html` : UI spectateur (vidéo delayed + affichage captions)

### `web/public/js/`
- `web/public/js/shared.js`
  - constantes API/HLS/WS
  - `WebSocketManager` (reconnect)
  - `HlsPlayerManager` (wrapper Hls.js)

- `web/public/js/admin.js`
  - poll `/api/live/status`
  - WS admin-status pour liste des sous-titreurs
  - start live avec config de fragmentation

- `web/public/js/subtitler.js`
  - login name
  - WS identify + fragment join
  - lecture HLS live
  - UI tour / grace / audio notifications
  - envoi caption + auto-send

- `web/public/js/spectator.js`
  - WS identify
  - lecture HLS delayed
  - attend assez de segments (fonction du delay)
  - affichage captions `caption:word`

### `web/public/vendor/`
- `web/public/vendor/hls.js` : lib Hls.js (bundle)

