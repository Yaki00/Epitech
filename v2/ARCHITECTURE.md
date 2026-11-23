# Lyra v2 : architecture, conventions et contrat d'API

**Assistant de code : lis d'abord `../opencode.md`.** Sur ce poste, tu installes, configures et testes ;
tu ne modifies pas le code. Ce fichier sert à comprendre le projet. Il complète `../v1/ARCHITECTURE.md`, dont tout ce qui
n'est pas redit ici reste vrai (périmètre, export Confluence, modèles d'IA). **Exception : l'extraction Confluence de la v1
(repérage par règles) est remplacée par la lecture IA vérifiée décrite plus bas.**

## Ce que la v2 ajoute à la v1

- Une **interface refaite** (React 19, TypeScript, Tailwind 4, Vite 8) : Accueil, Applications, Serveurs, Cartographie,
  Équipes, Supervision, Historique, Synchronisation, assistant en bulle.
- La **lecture des pages par l'IA** : l'IA repère (serveurs, bases, liens, responsables, nature et période de la page), le code
  vérifie (citation retrouvée, rapprochement avec l'inventaire). Plus aucune règle de repérage dans le code.
- Les **équipes et responsables** par application, lus dans la documentation (et dans l'APM s'il les fournit).
- Des **consignes en texte** (`config/consignes-ia.md`) pour adapter la lecture aux conventions de l'entreprise sans toucher au code.
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
      lib/environment.js   normalisation PRD, STG, DEV (sinon null), synonymes du bloc `environnements`
      reading/             lecture IA vérifiée : consignes, prompt, schema, readPage, evidence, verify, apply, syncPages, mockReadings
      demo/                generate.js (parc fictif), naemonMock.js, chatMock.js
      ...                  le reste comme en v1 (parse, ingest, perimeter, enrich, graph, store, assistant, fetch)
    scripts/               doctor.js, fetch-confluence.js, fetch-inventory.js, sync-inventory.js, sync-confluence.js, summarize-apps.js
    test/                  jest, sans réseau ni IA
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

## Lecture IA des pages : lecture, vérification, écriture

Le code ne repère rien dans le texte : ni liste de noms de serveurs, ni motif de nom ou d'IP, ni mot-clé de titre, ni score de
reconnaissance d'application. Tout ce qui dépend des conventions va dans les consignes. La chaîne, par page (`src/reading/`) :

1. **Lecture** (`readPage.js`, `prompt.js`, `schema.js`). Entrée : titre, pages parentes, espace, date de modification, sections du
   parseur (texte barré retiré, tableaux mis à plat), schémas draw.io en texte (boîtes et flèches), applications du périmètre et leurs
   variantes, consignes. Une page plus longue que `READING_CHUNK_CHARS` est coupée en morceaux (par sections, puis par paragraphes) lus
   l'un après l'autre et fusionnés. Un appel `chatJson` par morceau (tâche `extract`, température 0, `LLM_MAX_TOKENS_EXTRACT`). Un
   morceau vide, coupé ou illisible fait échouer la page entière, jamais une lecture partielle. Le résultat est nettoyé : valeurs hors
   liste écartées ou ramenées à une valeur neutre, éléments sans citation écartés, adresses électroniques et numéros de téléphone retirés.
2. **Vérification** (`evidence.js`, `verify.js`), sans modifier le graphe. Chaque élément garde sa citation seulement si elle se retrouve
   dans le texte de la page (comparaison tolérante : casse, accents, guillemets typographiques, espaces insécables, retours à la ligne,
   cellules de tableau). Les serveurs sont rapprochés de l'inventaire par `repo.resolve` (nom court, FQDN, IP), les applications du
   périmètre par `matcher.resolveAppName` (variantes, fautes, sigles : sert à rapprocher un nom rendu par l'IA, jamais à en repérer).
   Application inconnue ou hors périmètre, citation introuvable : élément rejeté avec sa raison.
3. **Écriture** (`apply.js`, `syncPages.js`). Les liens et rattachements issus de la page lue précédemment (`removeEdgesBySourceRef`,
   source `reading`) sont supprimés puis recréés ; les liens des inventaires ne sont jamais touchés. Les nœuds créés par d'anciennes
   lectures et plus cités par aucun lien actif sont marqués retirés (jamais supprimés).

### Formes

```
Reading  = { page: { kind, period, env, envEvidence, topics[] },
             applications: [{ name, written, role: subject|cited, evidence }],
             entities:     [{ name, type, env, status: active|decommissioned|planned, ip?, evidence }],
             links:        [{ from, to, type, period|null, evidence }],
             owners:       [{ name, kind: person|team, application, role: owner|support|oncall|other, evidence }] }

Verified = { kind, period, env, topics,
             apps:    [{ appId, role, written, evidence }],
             servers: [{ nodeId|null, name, ip, env, status, inInventory, corroborated, evidence }],
             links:   [{ src, dst, type, trust, period, evidence }],
             owners:  [{ appId, name, kind, role, period, evidence }],
             rejected: [{ what, reason: no_evidence|evidence_mismatch|unknown_application|out_of_scope }] }
```

L'en-tête envoyé à l'IA porte la date du jour (`Date du jour : AAAA-MM-JJ`) pour juger la période (« Plan 2026 » est actuel en 2026) ;
elle n'entre pas dans le texte où les citations sont cherchées. Chaque lien peut porter sa propre période (page qui mêle l'existant et
une cible, historique qui va jusqu'à aujourd'hui) ; sans période propre, il prend celle de la page. L'environnement de la page n'est
retenu que si sa citation (`envEvidence`) se retrouve dans la page et contient un mot qui le désigne (`PRD`, `production`, synonymes du
bloc `environnements` de `mappings.json`) : jamais déduit des serveurs cités. Sinon il est rejeté (`rejected`) et vaut `null`.

Types de lien : `runs_on`, `uses_db`, `db_on`, `calls`, `reads_from`, `writes_to`, `depends_on` (sens « src dépend de dst »).
Nature de la page : `architecture`, `exploitation`, `installation`, `incident`, `version`, `reunion`, `projet`, `autre`. Période :
`current`, `past`, `target`. Une valeur méconnaissable pour la période ou le statut vaut `null` (non fiable, traité comme « à valider »),
jamais « actuel » par défaut. Le détail exact est dans le code et dans `test/reading.test.js`, `test/verify.test.js`.

### Règles de confiance

Une citation prouve que la page le dit, pas que c'est vrai : l'inventaire reste la référence pour « quel serveur appartient à quelle
application ». `trust` d'un lien vaut `confirmed`, `added`, `toValidate` ou `otherApp`.

| L'IA lit « A tourne sur S » | Effet |
|---|---|
| S dans l'inventaire, rattaché à A | `confirmed` : non écrit, déjà dans l'inventaire |
| S dans l'inventaire, rattaché à une autre application | `otherApp` : non écrit, compté dans le contrôle de la page |
| S hors inventaire, supervisé par Naemon ou page actuelle modifiée depuis moins de 730 jours disant S actif (cette page, ou une autre déjà lue : liens `mentions`) | `added` : écrit, serveur marqué `outOfInventory`, compte dans l'impact |
| S hors inventaire sans corroboration (ou période illisible) | `toValidate` : écrit, inactif, listé dans `/api/gaps` |
| page ancienne ou cible, S décommissionné ou prévu | écrit avec `period` `past` ou `target`, inactif |

Un lien est **inactif** s'il est retiré, ancien, cible ou à valider (`isInactiveEdge`). Les liens inactifs sont ignorés par l'impact, les
compteurs, l'état Naemon, le score de documentation et la carte (sauf `includeRetired=true`), mais restent listés avec leur marque. Les liens
entre applications, vers les bases et base vers serveur n'ont pas d'inventaire : ils viennent des pages actuelles. Un autre lien vers un
serveur de l'inventaire (`db_on`, `depends_on`...) est `toValidate` si le serveur appartient à d'autres applications que celles du lien :
pour une base, une file ou une URL, ce sont les applications qui l'utilisent (`uses_db`, `reads_from`, `writes_to` de la page ou du
graphe actif), puis celles de la page (la base d'une application B hébergée sur un serveur de B, citée dans la page de A, reste juste).

### Décision par page et reprise

`readingHash = sha256(READING_VERSION | empreinte des consignes | empreinte du périmètre)`. Une page est relue par l'IA si elle n'a pas de
lecture gardée, si son contenu ou `readingHash` ont changé, ou avec `--force`. Si seule l'inventaire a changé (`verifyHash`), la vérification
et l'écriture sont refaites à partir de la lecture gardée (`attrs.reading`), sans IA. Sinon la page est sautée. Une page en erreur garde sa
lecture, son empreinte et ses rejets précédents et est reprise au passage suivant. La première analyse après la mise à jour relit donc toutes
les pages. Sans IA, les pages sont stockées et rien n'est déduit.

### Consignes, environnements, équipes

- `config/consignes-ia.md` (non versionné) : texte libre, 8 000 caractères au plus, lu par `reading/consignes.js` (absent ou vide = vide) et
  placé à la fin du message système. Modèle : `consignes-ia.example.md`. Le texte entre dans l'empreinte de la lecture.
- `environnements` (bloc facultatif de `mappings.json`) : synonymes d'environnement pour l'import des inventaires (`configureEnvironmentsFromFile`)
  et pour le contrôle de la citation de l'environnement d'une page.
- Équipes : nœuds `person` et `team`, liens `owned_by` (application vers personne ou équipe) avec `role`, `period` et la citation, plus les
  colonnes `owner` et `supportTeam` de l'APM si elles sont décrites. Ni adresse électronique ni téléphone ne sont stockés.
- Rapports CSV : `perimetre-pages`, `perimetre-orthographes`, `lectures-rejets`, `architecture-*`.

### Fiabilité des appels IA (`lib/llmClient.js`)

`LLM_REASONING_EFFORT` est ajouté aux requêtes quand il est défini. Une réponse vide, coupée (`finish_reason = length`) ou en JSON illisible
n'est jamais écrite au cache ; une nouvelle tentative a lieu avec le double de place (hors `LLM_MAX_RETRIES`), puis l'erreur porte un `code`
(`empty`, `truncated`, `invalid_json`). `doctor` fait une lecture d'essai et conseille `LLM_REASONING_EFFORT=none` en cas de réponse vide ou coupée.

## Score de documentation

`quality/docScore.js`, calculé à la volée : page d'architecture liée (35), aucune page d'architecture avec écart (25), part des
serveurs cités par une page liée (30), résumé disponible (10). Les éléments retirés et les liens inactifs sont ignorés ; seules les pages où
l'application est sujet principal comptent.

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
Tests : `cd frontend && npm test` (vitest).

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
| `GET /api/applications`, `/api/applications/:id` | + `retired`, `status` (état par environnement, `atRisk`), `docScore`, `owners[]` ; serveurs et bases portent `retired`, `env`, `state`, `active`, `trust`, `period` ; serveurs : `outOfInventory` |
| `GET /api/servers?q=&limit=` | + `env`, `retired`, `state` |
| `GET /api/servers/:id` | fiche serveur : état, services, applications, pages, changements concernant ce serveur |
| `GET /api/status` | état de la relève Naemon : source, dates, dernière erreur, états par serveur et application, hôtes non rapprochés |
| `GET /api/gaps` (`?format=csv`) | rapport d'écarts de supervision, plus `toValidate` (liens à valider) |
| `GET /api/teams` | personnes et équipes, leurs applications (rôle, période, source `doc` ou `apm`, pages) ; groupe « non renseignée » en dernier |
| `GET /api/changes?limit=` | historique des imports (20 par défaut, 200 au plus) |
| `POST /api/simulate` `{nodeIds, includeRetired?, depth?}` | simulation de panne sur plusieurs éléments (union des impacts) |
| `GET /api/map?scope=perimeter\|app:<id>&envs=PRD,STG&includeRetired=` | données de la cartographie |
| `GET /api/health`, `/api/search`, `/api/nodes/:id`, `/api/graph/:id`, `/api/impact/:id`, `/api/dependencies/:id` | comme en v1 |
| `GET /api/sync/runs`, `/api/sync/runs/:id/errors`, `GET/POST /api/sync/jobs` | page Synchronisation, comme en v1 |
| `POST /api/ask` `{question, history}` | assistant (réponse simulée en démo) |

Les formes détaillées sont dans le code (`src/api/views2.js`) et les tests (`test/`).
