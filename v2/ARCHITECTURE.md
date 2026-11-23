# Lyra v2 : architecture, conventions et contrat d'API

**Assistant de code : lis d'abord `../opencode.md`.** Sur ce poste, tu installes, configures et testes ;
tu ne modifies pas le code. Ce fichier sert à comprendre le projet. Il complète `../v1/ARCHITECTURE.md`, dont tout ce qui
n'est pas redit ici reste vrai (extraction, périmètre, pages d'architecture, export Confluence, modèles d'IA).

## Ce que la v2 ajoute à la v1

- Une **interface refaite** (React 19, TypeScript, Tailwind 4, Vite 8) : Accueil, Applications, Serveurs, Cartographie,
  Supervision, Historique, Synchronisation, assistant en bulle. Plus de page Équipes ni de responsable : ces données ne sont pas fiables.
- La **supervision Naemon en direct** (Thruk ou CSV) : état des serveurs et des applications, propagation du risque, rapport d'écarts.
- L'**historique** des imports et les **éléments retirés** (jamais supprimés).
- Le **score de documentation** par application.
- Les **environnements** `PRD`, `STG`, `DEV` (+ « Non précisé » quand le serveur n'en a pas), partout.
- La **simulation de panne** sur plusieurs éléments, la carte ELK, un **mode démo** complet.
- La **reprise de la v1** par `npm run setup`.

Principe inchangé : **l'impact se calcule par parcours du graphe (déterministe)**. L'IA construit le graphe et explique.
Une valeur absente reste absente : criticité = attribut `criticality`, sinon `confidentiality` (colonne AI de l'APM), jamais inventée ;
état inconnu = `unknown`, jamais « ok ».

## Contraintes dures

Identiques à la v1 pour le serveur : **Node 16.20.2**, Windows et Linux, CommonJS, packages du backend inchangés.
Interdits : `fetch` global, `structuredClone`, `findLast`, `toSorted`, `Object.groupBy`, préfixe `node:` dans les `require`.
Chemins par `path.join`. Requêtes sortantes par `src/lib/httpFetch.js` uniquement.

L'interface (`frontend/`) est en ESM et ne tourne que sous **Node >= 22.12** : elle se compile sur une autre machine, et
`frontend/dist` est **versionné** (`.gitignore` contient `!frontend/dist/`). Le poste Node 16 n'exécute jamais Vite.
Après toute modification de l'interface : `cd frontend && npm run build` puis commit de `dist`.

## Arborescence

```
v2/
  scripts/                 setup.js (installation + reprise v1), start.js, sync-all.js, lib/migrate.js
  backend/
    src/
      server.js            point d'entrée ; en DEMO_MODE génère le jeu fictif et branche relève et chat simulés
      config.js            tout vient de .env
      api/app.js           routes Express (+ sert FRONTEND_DIST) ; views.js (v1) et views2.js (v2) ; jobs.js
      naemon/              thruk.js, csvSource.js, source.js (choix), poller.js (relève périodique), status.js (états),
                           gaps.js (rapport d'écarts), setup.js
      history/history.js   snapshots.json, changes.json, retrait des disparus
      quality/docScore.js  score de documentation
      lib/environment.js   normalisation PRD, STG, DEV (sinon null)
      demo/                generate.js (parc fictif), naemonMock.js, chatMock.js
      ...                  le reste comme en v1 (parse, ingest, perimeter, enrich, graph, store, assistant, fetch)
    scripts/               doctor.js, fetch-confluence.js, fetch-inventory.js, sync-inventory.js, sync-confluence.js, summarize-apps.js
    test/                  jest (241 tests), sans réseau ni IA
  frontend/
    src/                   app (routes, layout), pages, components, map (graphe ELK dans un worker), lib (API, i18n FR/EN)
    dist/                  interface compilée, versionnée
```

## Stockage

Comme la v1 (`DATA_DIR`, fichiers JSON en mémoire, écriture atomique, verrou de synchro). Ajouts :

- `snapshots.json` : dernier ensemble vu par source d'inventaire (nœuds, liens, attributs suivis).
- `changes.json` : ajouts, retraits et modifications entre deux imports (`HISTORY_KEEP` entrées, 50 par défaut).
- Attributs `retired` et `retiredAt` sur nœuds et liens retirés.
- Le mode démo écrit dans `data/demo-store` (jamais mélangé à `DATA_DIR`).

## Historique et retraits

`sync-inventory.js` enregistre chaque source puis applique les retraits **une fois, après toutes les sources**.

1. Un import n'est **complet** que sans erreur, avec au moins une ligne et au moins un élément vu. Sinon : rien n'est enregistré, rien n'est retiré.
2. Le premier import est un simple point de départ (pas d'entrée d'historique).
3. Seuls sont retirés les serveurs portant une trace d'une source suivie (`<source>_row`) ; les serveurs venus d'ailleurs ne sont pas touchés.
4. Un élément retiré qui réapparaît est remis en service. Rien n'est jamais supprimé du graphe.
5. `impact`, `neighborhood`, les compteurs et la carte ignorent les retirés, sauf `includeRetired`.

## Supervision Naemon

`NAEMON_SOURCE` : `off`, `thruk`, `csv` (et `mock` en démo). Le poller relève toutes les `NAEMON_POLL_MINUTES` et garde
l'état précédent en cas d'erreur (jeton refusé, page HTML, réseau) ; `lastError` est exposé par `/api/status`.

Règles d'état (`naemon/status.js`) :

- Serveur : `ok`, `warning`, `critical`, `down`, `unknown` (pas de relève), `maintenance` (hôte en arrêt planifié), `not_monitored` (relève disponible mais serveur absent).
- Une maintenance planifiée ne propage **aucun** impact et un service en maintenance ne compte pas dans le pire état du serveur.
- Deux hôtes Naemon pour un même serveur : le plus grave l'emporte.
- Application : `ok`, `degraded`, `down`, `unknown`, calculée par environnement (`byEnv`). `atRisk` : application dont une dépendance (`calls`) est en panne, avec le chemin.
- Rapport d'écarts (`gaps.js`) : serveurs du graphe non supervisés, hôtes supervisés inconnus de l'inventaire, serveurs cités dans Confluence mais absents de l'inventaire. Indisponible (`available: false`) sans relève.

## Score de documentation

`quality/docScore.js`, calculé à la volée : page d'architecture liée (35), aucune page d'architecture avec écart (25), part des
serveurs cités par une page liée (30), résumé disponible (10). Les éléments retirés sont ignorés.

## Environnements

`lib/environment.js` ramène la valeur d'inventaire à `PRD`, `STG` ou `DEV` ; tout le reste (vide, valeur inconnue) donne `null`,
affiché « Non précisé ». Un serveur sans environnement n'est jamais perdu : la carte l'affiche dans sa zone « Non précisé ».
Filtre par défaut de l'interface : `PRD` et `STG` ; `DEV` d'un clic ; le choix est mémorisé dans le navigateur.

## Mode démo

`DEMO_MODE=true` : `demo/generate.js` génère un parc fictif reproductible (graine fixe), `naemonMock.js` simule la supervision
(état qui évolue) et `chatMock.js` répond à l'assistant sans IA. Aucun appel réseau ; les boutons de synchronisation sont coupés.
`doctor` signale le mode démo par un avertissement pour éviter de le laisser actif par erreur.

## Reprise de la v1

`scripts/lib/migrate.js`, appelé par `setup.js` si `../v1/backend/.env` existe et `backend/.env` n'existe pas. N'écrase jamais
un fichier, ne modifie jamais la v1, écrit `.env` en dernier (sa présence signifie « reprise complète »). Le bloc ajouté à
`.env` est placé après les lignes de la v1 dont les clés concernées sont mises en commentaire (dotenv garde la dernière occurrence, donc le bloc v2 l'emporte ; les lignes de la v1 sont commentées par clarté).
`CONFLUENCE_FETCH=false` : `fetch-confluence.js` s'arrête proprement (code 0) et `doctor` n'interroge pas Confluence.

## Frontend

React 19, react-router 7, Tailwind 4, `@xyflow/react` (carte), ELK dans un Web Worker (disposition), `cmdk` (palette de commandes),
`html-to-image` (export PNG). Bilingue FR / EN (`src/lib/i18n.tsx`, un test vérifie que les deux dictionnaires ont les mêmes clés).
Règles : pas de 0 trompeur pour une source non branchée ; état de supervision rafraîchi par `src/lib/live.tsx` ; aucun tiret long dans les textes.
Tests : `cd frontend && npm test` (vitest, 74 tests).

## Conventions

Celles de la v1 (lien `src -> dst` = « src dépend de dst », `source` et `confidence` sur chaque lien, ids `<type>:<clé>`, règles avant IA,
idempotence, un modèle par tâche, aucun secret dans le code), plus :

1. Environnements : uniquement `PRD`, `STG`, `DEV` ou `null`.
2. Aucune valeur inventée : criticité, état, environnement viennent d'une source ou restent vides.
3. Un import incomplet ou une relève en erreur ne détruit rien.
4. Tout nouveau calcul (état, retrait, score, écart) a un test jest sous Node 16.20.

## Contrat d'API

Les routes v1 restent identiques (seuls des champs sont ajoutés). Nouvelles ou étendues :

| Route | Usage |
|---|---|
| `GET /api/config` | `demo`, `naemonSource`, `version`, `naemonUrlTemplate`, sources branchées |
| `GET /api/overview` | Accueil : compteurs, applications et états, alertes, applications à risque, sources, changements récents, écarts, moins bien documentées |
| `GET /api/applications`, `/api/applications/:id` | + `retired`, `status` (état par environnement, `atRisk`), `docScore` ; serveurs et bases portent `retired`, `env`, `state` |
| `GET /api/servers?q=&limit=` | + `env`, `retired`, `state` |
| `GET /api/servers/:id` | fiche serveur : état, services, applications, pages, changements concernant ce serveur |
| `GET /api/status` | état de la relève Naemon : source, dates, dernière erreur, états par serveur et application, hôtes non rapprochés |
| `GET /api/gaps` (`?format=csv`) | rapport d'écarts de supervision |
| `GET /api/changes?limit=` | historique des imports (20 par défaut, 200 au plus) |
| `POST /api/simulate` `{nodeIds, includeRetired?, depth?}` | simulation de panne sur plusieurs éléments (union des impacts) |
| `GET /api/map?scope=perimeter\|app:<id>&envs=PRD,STG&includeRetired=` | données de la cartographie |
| `GET /api/health`, `/api/search`, `/api/nodes/:id`, `/api/graph/:id`, `/api/impact/:id`, `/api/dependencies/:id` | comme en v1 |
| `GET /api/sync/runs`, `/api/sync/runs/:id/errors`, `GET/POST /api/sync/jobs` | page Synchronisation, comme en v1 |
| `POST /api/ask` `{question, history}` | assistant (réponse simulée en démo) |

Les formes détaillées sont dans le code (`src/api/views2.js`) et les tests (`test/`).
