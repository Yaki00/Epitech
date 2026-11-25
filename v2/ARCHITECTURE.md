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
- L'**assistant opérationnel** : fiches de dépannage, de procédure et de bonnes pratiques lues par l'IA (`src/knowledge/`), recherche
  aidée du graphe, outils du chat avec sources et contrôle des liens.

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
      knowledge/           fiches opérationnelles : prompt, schema, readFiches, verify, apply, search (BM25 + graphe), rerank
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
   liste écartées ou ramenées à une valeur neutre, éléments sans citation écartés, numéros de téléphone retirés, et partie avant le `@` des adresses retirée (le domaine reste : dans `ssh deploy@srv01.domaine.lan`, la citation garde `srv01.domaine.lan`).
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
Reading  = { page: { kind, period, periodEvidence, env, envEvidence, topics[] },
             applications: [{ name, written, role: subject|cited, evidence }],
             entities:     [{ name, type, env, status: active|decommissioned|planned, ip?, evidence }],
             links:        [{ from, to, type, period|null, periodEvidence, evidence }],
             owners:       [{ name, kind: person|team, application, role: owner|support|oncall|other, evidence }] }

Verified = { kind, period, env, topics,
             apps:    [{ appId, role, written, evidence }],
             servers: [{ nodeId|null, name, ip, env, status, inInventory, corroborated, disputed, evidence }],
             links:   [{ src, dst, type, trust, period, evidence }],
             owners:  [{ appId, name, kind, role, period, evidence }],
             rejected: [{ what, reason: no_evidence|evidence_mismatch|not_in_header|unknown_application|out_of_scope }] }
```

L'en-tête envoyé à l'IA porte la date du jour (`Date du jour : AAAA-MM-JJ`, heure locale du serveur) pour juger la période (« Plan
2026 » est actuel en 2026) ; elle n'entre pas dans le texte où les citations sont cherchées. Chaque lien peut porter sa propre période
(page qui mêle l'existant et une cible, historique qui va jusqu'à aujourd'hui) ; sans période propre, il prend celle de la page. Une
période ancienne ou cible n'est gardée que si elle est prouvée : pour la page, sa citation (`periodEvidence`) se retrouve dans la page et
contient un mot de cette période (obsolète, archivée, historique, remplacée, cible, prévue, projet...), ou le titre et les pages parentes en
contiennent un ; pour un lien, la même période que la page, ou sa citation (`periodEvidence` ou `evidence`) qui contient un tel mot. Une date
ou une année seule ne prouve rien (« Cartographie 2024 », « Note de version 7.3 ») : la page est alors actuelle (rejet `période de la page (past)`) et le
lien prend la période de la page. Un lien
dit actuel dans une page ancienne est au mieux `toValidate` (sauf `confirmed` par l'inventaire). L'environnement de la page n'est
retenu que si sa citation (`envEvidence`) se retrouve dans l'en-tête (titre, pages parentes) et contient un mot qui le désigne (`PRD`,
`production`, synonymes du bloc `environnements` de `mappings.json`) : jamais déduit d'une section, d'une phrase ou des serveurs
cités. Sinon il est rejeté (`rejected`, raison `not_in_header` ou `evidence_mismatch`) et vaut `null`.

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
| S hors inventaire, supervisé par Naemon ou page actuelle modifiée depuis moins de 730 jours disant S actif (cette page, ou une autre page non retirée déjà écrite : liens `mentions`) | `added` : écrit, serveur marqué `outOfInventory`, compte dans l'impact |
| S hors inventaire sans corroboration (ou période illisible) | `toValidate` : écrit, inactif, listé dans `/api/gaps` |
| S hors inventaire dit arrêté par une autre page non retirée, actuelle ou plus récente que celle-ci (`disputed`) | `toValidate`, même s'il est supervisé par Naemon ou cité actif ailleurs |
| page ancienne ou cible, S décommissionné ou prévu | écrit avec `period` `past` ou `target`, inactif |

Un lien est **inactif** s'il est retiré, ancien, cible ou à valider (`isInactiveEdge`). Les liens inactifs sont ignorés par l'impact, les
compteurs, l'état Naemon, le score de documentation et la carte (sauf `includeRetired=true`), mais restent listés avec leur marque. Les liens
entre applications, vers les bases et base vers serveur n'ont pas d'inventaire : ils viennent des pages actuelles. Un autre lien vers un
serveur de l'inventaire (`db_on`, `depends_on`...) est `toValidate` si le serveur appartient à d'autres applications que celles du lien :
pour une base, une file ou une URL, ce sont les applications qui l'utilisent (`uses_db` actuels de la page ; `uses_db`, `reads_from`,
`writes_to` actifs du graphe), puis celles de la page (la base d'une application B hébergée sur un serveur de B, citée dans la page de A, reste juste).

### Décision par page et reprise

`readingHash = sha256(READING_VERSION | empreinte des consignes | empreinte du périmètre)`. Une page est relue par l'IA si elle n'a pas de
lecture gardée, si son contenu ou `readingHash` ont changé, ou avec `--force`. Si seule l'inventaire a changé (`verifyHash`), la vérification
et l'écriture sont refaites à partir de la lecture gardée (`attrs.reading`), sans IA. Sinon la page est sautée. Une page en erreur garde sa
lecture, son empreinte et ses rejets précédents et est reprise au passage suivant. L'année de lecture est gardée (`readingYear`) :
l'année suivante, seules les pages dont la lecture a une période ancienne ou cible (page ou lien) sont relues. En fin de passage, les
pages vérifiées pendant le passage dont un lien est resté `toValidate`, ou qui citent un serveur hors inventaire, sont vérifiées et écrites
une seconde fois, sans IA : la règle « base d'une autre application », la corroboration par une autre page et le serveur dit arrêté ailleurs
ne dépendent alors plus de l'ordre de lecture. `verifyHash` compte aussi les citations « arrêté » des serveurs hors inventaire : une page
nouvelle ou modifiée qui dit un tel serveur arrêté fait revérifier, sans IA, les pages sautées au passage suivant (les pages vérifiées pendant
le passage prennent l'empreinte de fin). La première analyse après la mise à jour relit donc toutes
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
(`empty`, `truncated`, `invalid_json`). `doctor` fait une lecture d'essai et conseille `LLM_REASONING_EFFORT=none` en cas de réponse vide ou coupée. Si la passerelle refuse
`reasoning_effort` (400), le réglage est retiré pour la suite (avertissement dans le journal). Tant que la réflexion n'est pas coupée
(réglage vide ou refusé), chaque appel reçoit au moins `LLM_MAX_TOKENS_REASONING` (8192 par défaut) de place de réponse.

## Assistant opérationnel : fiches, recherche, outils du chat

Conception : `docs/2026-11-24-v2-assistant-operationnel-conception.md`. Code : `src/knowledge/` (sauf les outils du chat, dans
`src/assistant/ask.js`). Aucun paquet ajouté : la recherche est écrite dans le projet.

### Fiches (`knowledge/schema.js`, `readFiches.js`, `verify.js`)

Une page dont la nature lue est `incident`, `release`, `operations`, `install` ou `other` (`OPS_KINDS`) reçoit, après sa lecture, un
**second appel IA** par morceau (même découpage, mêmes consignes) qui rend des fiches ; les morceaux sont fusionnés (même type et même
titre normalisé : une seule fiche). Types (`FICHE_KINDS`) et leurs champs (`FICHE_SHAPE`) :

| Type | Champs (texte) | Listes |
|---|---|---|
| `incident` | `symptoms`, `cause`, `solution` | `errors`, `actions`, `tickets` |
| `correctif` | `version` | `tickets` |
| `procedure` | `goal`, `when`, `prerequisites`, `cautions` | `steps` |
| `pratique` | aucun | `rules` |

Chaque fiche porte aussi : `title`, `section`, `date`, `apps` et `servers` cités, `keywords` (mots de recherche rendus par l'IA, 12 au
plus, jamais montrés comme un fait), `replaces` (procédure remplacée) et `fixes` (incident corrigé). Tout élément est de la forme
`{ text, evidence }` : la citation (`evidence`) doit se retrouver dans la page (`hasEvidence`), sinon l'élément est écarté. Sont aussi
rejetés : une citation qui ne contient ni le texte ni un mot de 4 lettres ou plus de ce texte (`evidence_mismatch`), et tout élément dont
le texte ou la citation ressemble à un mot de passe, un jeton ou une clé (`secret`, motif `SECRET` : l'élément entier est retiré). Les
numéros de téléphone sont retirés, ainsi que la partie avant le `@` des adresses (une étape `ssh deploy@srv01.domaine.lan` garde le nom
du serveur). Les applications et serveurs sont rapprochés comme dans la lecture des
pages (`matcher.resolveAppName`, `repo.resolve`) ; un nom inconnu reste en texte (`unresolved`), sans lien. Une page peut donner
plusieurs fiches, ou aucune.

### Graphe (`knowledge/apply.js`)

- Nœud `fiche:<pageId>-<n>` (type `fiche`, `attrs.kind` = le type), avec `url` (page, plus l'ancre de la section si la page en a une),
  `period` et `updatedAt` de la page, `fields`, `lists`, `tickets`, `keywords`, `replaces`, `fixes`, `replacedBy`. Relire la page purge ses
  liens `knowledge` et marque `retired` les fiches en trop (jamais supprimées).
- Liens (source `knowledge`) : `concerne` (fiche vers application ou serveur), `vient_de` (fiche vers le document), `corrige` (correctif
  vers incident, refait en fin de passage par `linkFiches` : ticket partagé, ou texte `fixes` qui nomme le titre de l'incident).
- `linkFiches` marque aussi la procédure remplacée (`replacedBy`, `replacedByEvidence`) : le lien Confluence cité par `replaces`, sinon
  même application et même but ; la correspondance doit être unique et la procédure remplacée strictement plus ancienne.
- **Ces liens ne propagent jamais** : `concerne`, `vient_de` et `corrige` sont dans `NON_PROPAGATING` (`graph/impact.js`), donc ignorés
  par l'impact, la carte, le score et les compteurs. Les fiches `incident` et `correctif` décrivent le passé par nature : jamais
  pénalisées pour leur période.

### Empreintes et reprise

`opsHash = sha256(OPS_VERSION | empreinte des consignes | empreinte du périmètre)` (16 caractères), écrit dans la ligne document avec
`opsContentHash` (empreinte du contenu) et `ficheCount`. Une page dont la lecture est à jour mais dont `opsHash` ou `opsContentHash`
est périmé ne refait que ses fiches. Changer `OPS_VERSION` (consignes ou forme des fiches) ne relance donc que les fiches. Une fiche en
échec n'arrête jamais le passage ni ne met la page en erreur : elle compte dans `stats.ficheErrors` (statut du passage `partial`),
l'erreur est enregistrée avec l'étape `fiches` et l'empreinte reste ancienne, donc reprise au passage suivant.

### Fichier des sections

À chaque passage, `knowledge-sections.json` (dans `DATA_DIR`, écriture atomique) reçoit les sections de **toutes** les pages
(`pageId`, `title`, `url` avec ancre, `section`, `text`, `period`), y compris les pages sautées. Tout ce qui ressemble à un secret y est
remplacé par `[masqué]`, et les numéros de téléphone et la partie avant le `@` des adresses sont retirés (même nettoyage que pour les fiches). Un passage
limité (`--limit`) ne réécrit pas ce fichier : il n'a vu qu'une partie des pages. Il sert de second recours à la recherche. Illisible ou absent : la recherche porte sur les fiches seules
(un avertissement par démarrage).

### Recherche (`knowledge/search.js`)

Index en mémoire, reconstruit au démarrage et à chaque rechargement du store (`buildKnowledgeIndex`). Les fiches retirées ne sont
jamais rendues.

1. **BM25** maison sur les fiches (`K1 = 1.2`, `B = 0.75`) ; titre et mots de recherche comptés deux fois (`TITLE_WEIGHT = 2`). Textes
   normalisés comme les citations (casse, accents), pluriels simplifiés, mots vides ignorés.
2. **Mots techniques entiers** : un mot qui contient un chiffre, un point, un tiret ou un souligné (`Q.DEM.EVT`, `ORA-01555`, nom de
   serveur) est gardé entier en plus d'être découpé. Dans la question, les mots techniques passent d'abord et seuls ceux présents dans
   l'index comptent (80 au plus) : une longue pile d'erreur collée ne noie pas le code d'erreur.
3. **Bonus du graphe** : la question est rapprochée des applications et serveurs connus (`matcher.scanText` avec confiance d'au moins
   0,7, `repo.resolve`, plus l'argument `application`). Fiche de l'application ou du serveur de la question : x1,5 (`OWN_APP_BONUS`) ;
   fiche d'une **voisine** : x1,2 (`NEIGHBOUR_BONUS`). Voisines : applications liées par un lien actif `calls`, `depends_on`,
   `reads_from` ou `writes_to` (dans les deux sens), et celles qui partagent un serveur, une base ou une file actifs.
4. **Pénalités** : procédure ou pratique de période `past` x0,5 (`OLD_MALUS`), de même qu'une section d'une page de période `past` ;
   procédure remplacée (`replacedBy`) x0,3
   (`REPLACED_MALUS`).
5. **Égalités** : par blocs de scores à 5 % près (`TIE_WINDOW`), la fiche dont la page est la plus récente passe d'abord.
6. **`otherApplication`** : vrai pour une fiche qui concerne des applications, aucune n'étant celle de la question (alors qu'une
   application de la question est reconnue) : l'assistant dit que c'est « la plus proche », pas celle demandée.
7. **Sections de pages** en second recours : au plus cinq, sans doublon avec une fiche déjà rendue (même page et même section).
   Chaque section rendue porte `period` et `old` (vrai si la page est de période `past`).

Résultat : `{ fiches (10 par défaut, 50 au plus), sections, apps }`. Chaque fiche rendue : `id`, `kind`, `title`, `appNames`, `period`,
`updatedAt`, `url`, `section`, `excerpt`, `score`, `old`, `replaced`, `otherApplication`. Sans fiche ou sans mot utile : listes vides, sans erreur.

### Reclassement facultatif (`knowledge/rerank.js`)

Éteint par défaut (`KNOWLEDGE_RERANK=false`). Activé, les 20 premières fiches (`RERANK_TOP`) sont envoyées à `llm.rerank` (modèle
`LLM_MODEL_RERANK`, chemin `KNOWLEDGE_RERANK_PATH` relatif à `LLM_BASE_URL`, `/rerank` par défaut ; appel `model`, `query`, `documents`,
réponse `results[].index` et `relevance_score`) et réordonnées par score décroissant (tri stable) ; le reste ne bouge pas. Une erreur ou
une réponse incomplète garde l'ordre par mots-clés ; l'échec est signalé une seule fois par démarrage. `doctor` n'essaie le
reclassement que s'il est activé.

### Outils du chat et contrôle des liens (`assistant/ask.js`)

Deux outils s'ajoutent aux quatre existants, en mode natif comme en mode JSON :

- `search_knowledge(query, application?)` : résultat de la recherche (fiches puis sections), reclassé si activé ; sans index, des listes vides.
- `open_fiche(id)` : la fiche complète (`getFiche`) avec champs, listes, citations, lien, section, `old`, `replaced`, `replacedBy` ;
  `{ error }` si elle est inconnue ou retirée.

La consigne système demande de chercher avant de répondre à toute question de dépannage, de procédure ou de pratique, de donner les
étapes telles que la fiche les donne, de citer titre et lien, de dire « ancienne », « remplacée » ou « autre application », et de dire
« rien trouvé dans la documentation » sans rien inventer. Un outil qui plante renvoie `{ error }` au modèle sans faire échouer la question.

**Contrôle par le code**, après la réponse : toute URL de la réponse (lien markdown, entre chevrons, nue) absente des résultats d'outils
de **cette** question est retirée (un lien markdown garde son libellé) et listée dans `removedLinks`. La réponse porte aussi `sources` :
les fiches ouvertes par `open_fiche`, plus les fiches et sections dont l'adresse figure dans la réponse finale (`id`, `kind`, `title`,
`url`, `updatedAt` (date de la page, absente pour une section), `appNames`, `old`, `replaced`, `otherApplication`). Une fiche ouverte garde `otherApplication` (et `old`, `replaced`) de la recherche de la même question, même sans lien dans la réponse ; une section porte son `old`. Pour un incident ou un correctif, `period` n'est pas montrée au modèle (seul `old` compte). Quand la réponse finale est la formule « rien trouvé », `sources` est vide. L'apostrophe (droite ou typographique) fait partie d'une adresse quand elle est entre deux caractères d'adresse, et n'est retirée qu'en fin d'adresse. Le nombre d'étapes reste borné (`maxRounds`, 5) ; s'il est épuisé après des recherches documentaires qui n'ont rendu ni fiche ni section, la réponse est la formule fixe « Rien trouvé dans la documentation pour cette question. » (EN : « Nothing found in the documentation for this question. »), sans lien ni source.

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
(état qui évolue) et `chatMock.js` répond à l'assistant sans IA. Aucun appel réseau ; la recherche de la documentation n'utilise que les données de la démo (matcher de la démo, aucun `knowledge-sections.json` ni `perimeter.json` réel) ; les boutons de synchronisation sont coupés.
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
| `GET /api/applications`, `/api/applications/:id` | + `retired`, `status` (état par environnement, `atRisk`), `docScore`, `owners[]`, `knowledge[]` (fiches de l'application, plus récentes d'abord : `id`, `kind`, `title`, `period`, `updatedAt`, `url`, `old`, `replaced`) ; serveurs et bases portent `retired`, `env`, `state`, `active`, `trust`, `period` ; serveurs : `outOfInventory` |
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
| `POST /api/ask` `{question, history, lang?}` | assistant (réponse simulée en démo) ; rend `answer`, `toolTrace`, `toolsMode`, `sources[]` (fiches et pages citées ou ouvertes), `removedLinks[]` (liens retirés par le contrôle) |
| `GET /api/knowledge/search?q=&app=&limit=` | recherche dans les fiches et les sections : `{ fiches, sections, apps }` ; `limit` 10 par défaut, 50 au plus ; vide sans fiche, 500 `recherche indisponible` en cas d'erreur |
| `GET /api/knowledge/:id` | une fiche complète (`fields`, `lists` avec citations, `tickets`, `url`, `section`, `old`, `replaced`, `replacedBy`) ; 404 si inconnue ou retirée |

Les formes détaillées sont dans le code (`src/api/views2.js`) et les tests (`test/`).
