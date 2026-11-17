# Lyra v1 : architecture, conventions et feuille de route

Lis ce fichier en entier avant de modifier le code.

## Objectif

Lyra construit un **graphe de dépendances** de l'infrastructure (applications, serveurs, bases, flux)
à partir d'un **export local de Confluence** (2 espaces, ~3000 pages), de l'export marketplace (serveurs),
de l'export APM, de Naemon et plus tard de ServiceNow/Bitbucket. Il sert à **l'analyse d'impact** :
« si je touche X, qui est impacté ? ».

**Principe clé : l'impact se calcule par parcours du graphe (déterministe). L'IA sert à construire le
graphe (extraction) et à expliquer les résultats (chat), jamais à calculer l'impact.**

## Environnement cible (contraintes dures)

- **Node 16.20.2.** Interdit : `fetch` global, `node:sqlite`, `structuredClone`, `process.loadEnvFile`,
  `Array.prototype.findLast` / `toSorted`, `Object.groupBy`, `AbortSignal.any`. Autorisé : `.at()`, `Object.hasOwn`,
  `crypto.randomUUID`, `AbortController`, `??`, `?.`, regex avec lookbehind.
  Les `require` se font sans préfixe `node:` (`require('fs')`).
- **Windows (poste) ET Linux (serveur).** Chemins via `path.join` / `path.resolve` uniquement. Scripts npm = fichiers Node
  (pas de `rm -rf`, pas de `VAR=x commande`). Noms de dossiers avec espaces, accents, parenthèses acceptés.
- **Liste de packages fermée.** Aucun ajout.

| Backend (`backend/package.json`, CommonJS) | Utilisé ? |
|---|---|
| `express` ^4.18.2 | oui : API (`express.json()`) |
| `dotenv` ^17.4.2 | oui : lecture de `backend/.env` (dans `src/config.js`, option `quiet`) |
| `cheerio` **`1.0.0-rc.12` exact** (≥ 1.0.0 exige Node 18) | non (installé, disponible) |
| `cors`, `body-parser`, `node-html-parser` | non (installés, disponibles) |
| dev : `jest` ^29.7.0, `supertest` ^7.0.0 | `jest` : `npm test` |

Le HTML Confluence est lu par le parseur maison `src/lib/xml.js` (même parseur pour le format rendu et le storage).

**Frontend** (`frontend/package.json`, ESM) : React 18, react-router-dom 6, cytoscape + cytoscape-dagre, uuid, Tailwind 3,
Vite 6, Vitest 5, jsdom 29, Testing Library. **Vite 6 / Vitest 5 / jsdom 29 ne tournent pas sous Node 16** :
le frontend se compile sur une machine Node ≥ 20 (`npm run build`), puis `frontend/dist` est copié sur le poste ;
le backend le sert (`FRONTEND_DIST`). Le poste Node 16 n'exécute jamais Vite.

## Stockage : fichiers JSON (pas de base SQL en V1)

- `DATA_DIR` (défaut `backend/data/store`) : `nodes.json`, `aliases.json`, `edges.json`, `documents.json`,
  `sync_runs.json`, `processing_errors.json`, puis `meta.json` écrit en dernier (marque une sauvegarde complète).
- Tout est chargé **en mémoire** ; écriture **atomique** (fichier temporaire puis `rename`, nouvelles tentatives sous Windows).
- **Seuls `store/store.js` et `store/repo.js` touchent aux données.** Le reste ne connaît que l'API de `createRepo`.
  Passer à SQLite plus tard = réécrire ces deux fichiers.
- Les synchros prennent un verrou (`DATA_DIR/.sync.lock`), sauvegardent toutes les 100 pages et à la fin (même en erreur).
- Le serveur API recharge les données si une synchro a écrit depuis (`reloadIfChanged`, vérifié à chaque requête `/api`).
- `DATA_DIR` est reconstructible : on peut le supprimer et relancer `npm run sync`.

## Source Confluence (export local, lecture seule)

Lyra n'appelle pas Confluence : le fetcher a déjà tout téléchargé dans `CONFLUENCE_EXPORT_DIR`.

```
<CONFLUENCE_EXPORT_DIR>/…/0006 - Paris Service Delivery/
  metadata.json        pageId (obligatoire), title, url, spaceKey, version, updatedAt, parentId, ancestors, labels…
  page.html            HTML RENDU ("view"), fragment sans <html>/<body>
  page.storage.xml     optionnel : format storage (paramètres des macros draw.io, Jira…)
  images/              optionnel
  attachments/         optionnel : <nom du diagramme>(.drawio|.xml)
```

1. **Clé d'une page = `metadata.pageId`.** Le nom du dossier est un numéro d'ordre instable.
2. Parcours **récursif** : tout dossier contenant `metadata.json` + `page.html` est une page. Une page illisible est
   enregistrée en erreur (étape `read`) sans arrêter la synchro.
3. Incrémental : `exportHash = sha256(page.html + page.storage.xml)`.
4. `page.html` → `parse/confluence/viewHtml.js` ; si `page.storage.xml` existe, ses diagrammes / macros / Jira / liens
   complètent le rendu (`mergeStorageMacros`). Le texte vient toujours du rendu (il contient les inclusions).
5. **Texte barré = obsolète** (`s`, `del`, `strike`, `style*=line-through`) : retiré avant extraction, compté dans `obsoleteFragments`.
6. `metadata.entities` et `metadata.keywords` sont **ignorés** (le fetcher prend des téléphones pour des IP).
7. `version: 0` = inconnue (`null`). `updatedAt` de la page est gardé sur le document et sur chaque lien (`attrs.pageUpdatedAt`).
8. Application documentée : titre = application (0.8), début du titre « OrderHub - Servers » (0.7), page parente (0.6).
9. Le format historique `pages/*.json` + `attachments/<pageId>/` reste accepté.

## Architecture (backend/)

```
src/
  server.js                 point d'entrée : charge config, store, app ; écoute HOST:PORT
  config.js                 tout vient de .env (dotenv), chemins résolus par rapport à backend/
  lib/
    httpFetch.js            SEUL client HTTP sortant (http/https) : équivalent de fetch pour Node 16, timeout, AbortController
    llmClient.js            SEUL point d'appel IA : retry/backoff, concurrence, cache disque, mock, chatJson
    mcpClient.js            SEUL point d'appel MCP (ServiceNow, Bitbucket, Jira)
    json.js                 parsing JSON robuste des réponses LLM (+ validation)
    xml.js                  parseur XML/HTML tolérant + removeElements / isObsolete
    csv.js, hash.js, limiter.js, logger.js
  resolve/entities.js       règles déterministes : IP stricte (pas de téléphone), FQDN, chemins, nom canonique, alias
  parse/confluence/
    viewHtml.js             page.html (rendu) -> sections (avec ancre), tableaux, liens, images (+ section), draw.io, Jira, entités
    storage.js              format storage -> même sortie
    drawio.js               diagramme draw.io -> nœuds, liens, conteneurs (sans vision)
  ingest/
    confluenceExport.js     parcours de l'export local, métadonnées, analyse d'une page, diagrammes
    confluence.js           page analysée -> graphe (mentions, documented_in, liens draw.io)
    inventory.js            CSV piloté par config/mappings.json ; "file" accepte * (le plus récent)
  enrich/relations.js       extraction IA : UN appel par section, sortie JSON validée
  store/store.js, repo.js   stockage JSON en mémoire (voir plus haut)
  graph/impact.js           impactOf / dependenciesOf / neighborhood (format cytoscape)
  assistant/ask.js          chat avec outils ; LLM_TOOLS_MODE=native (function calling) ou json (repli, automatique sur refus 400)
  api/app.js                routes Express (+ sert FRONTEND_DIST)
  api/views.js              vues prêtes à afficher pour le front
scripts/                    doctor.js, sync-inventory.js, sync-confluence.js
test/                       jest (*.test.js, assertions avec le module assert) + fixtures/confluence-export/
```

Racine : `npm run setup` (installe le backend, et le frontend seulement si Node ≥ 20), `npm start` (backend seul si
`frontend/dist` existe), `npm run doctor`, `npm run sync`, `npm test`.

## Frontend (frontend/)

React 18 + Vite 6 + Tailwind 3 + react-router 6 + cytoscape/cytoscape-dagre. Port 3000 en dev, proxy `/api` -> 3001.
`src/api/client.js` (seul accès HTTP), `src/lib/format.js` (criticité normalisée FR/EN, dates UTC « AAAA-MM-JJ HH:MM:SS »),
`src/components/` (Layout, ui, GraphView, ChatWidget, Icons SVG maison), `src/pages/` (une page par écran).
Règles : pas de 0 trompeur pour une source non branchée (afficher « non connecté ») ; classes Tailwind écrites en entier.

## Conventions (à respecter)

1. **Lien `src -> dst` = « src dépend de dst »** (app `runs_on` serveur, app `uses_db` base, app `calls` app).
   Les liens `mentions`, `documented_in`, `monitored_by` ne propagent pas l'impact.
2. **Chaque lien a une `source` et une `confidence`** : 1.0 source structurée, 0.8 draw.io, ≤ 0.8 IA.
3. **Ids de nœuds** : `<type>:<clé canonique>` (`server:srv01`, `application:alto`). Serveurs : nom court en minuscules ; FQDN et IP en alias.
4. **Règles avant IA** : tout ce qui se tranche par une règle (IP, chemin = filesystem, FQDN) ne part pas au LLM.
5. **Jamais de `null` silencieux** : une erreur est enregistrée (`processing_errors`, document `status = 'error'`) et visible dans la page Synchronisation.
6. **Idempotence** : relancer un script donne le même résultat (clé unique d'un lien : `src|dst|type|source|sourceRef`). Synchro incrémentale par empreinte.
7. **Un modèle par tâche, défini dans `.env`** (`LLM_MODEL_EXTRACT`, `LLM_MODEL_CHAT`…). Ne jamais utiliser `qwen-latest` (alias mouvant).
8. **Aucun secret dans le code.** Tokens dans `backend/.env` uniquement.
9. Tests : `npm test` (jest) doit passer sous Node 16.20. Toute nouvelle fonction de parsing ou de graphe a un test.
10. CommonJS côté backend, compatible Node 16.20.2, aucune nouvelle dépendance.

## Modèles disponibles (passerelle interne, compatible OpenAI)

| Tâche | Modèle | Pourquoi |
|---|---|---|
| Extraction en masse | `qwen3.6-35b-a3b` | MoE ~3B actifs : rapide pour 3000 pages |
| Chat, résumés | `qwen3.8-27b` | qualité, peu d'appels |
| Schémas (images) | `gemma-4-31b` | multimodal |
| OCR captures | `mistral-ocr-4` | texte des images |
| Embeddings | `qwen3-embedding-8b` | multilingue, 32K |
| Reranker | `bge-reranker-v2-m3` | multilingue |
| Code dans l'IDE | `qwen3-coder-next` | **texte seulement, pas de vision** |

À éviter : `bge-large-en` (anglais seul), `multilingual-e5-large` (512 tokens).

## Feuille de route

- [x] Étape 1 — Socle : config, client LLM/MCP, réconciliation, ingestion CSV, graphe d'impact, API, tests
- [x] Étape 2 — Confluence sans IA : sections, tableaux, liens, draw.io
- [x] Étape 2b — V1 Node 16 : stockage JSON, export Confluence local (page.html rendu), IP stricte, texte barré ignoré, jest, chat sans function calling
- [~] Étape 3 — IA : extraction des relations (fait) ; images à faire :
      hash des images (dédoublonnage) -> classification -> OCR (mistral-ocr) ou schéma (gemma, sortie nœuds/liens JSON).
      `viewHtml` donne déjà, pour chaque image, son fichier d'origine et sa section ; il manque la correspondance avec `images/img_N` (à fournir par le fetcher).
- [ ] Étape 3b — Jeu d'évaluation : 20 pages annotées à la main, comparer les modèles (précision, liens manqués, temps)
- [ ] Étape 4 — Naemon (mapping CSV ou Livestatus) : hôtes supervisés, dépendances, rapport d'écarts
- [ ] Étape 5 — ServiceNow (MCP limité à 200 résultats : `mcpClient.fetchAllByWindows`, ou export CSV) ; Bitbucket pour les PRs
- [ ] Étape 6 — Recherche documentaire (embeddings + reranker) branchée dans `assistant/ask.js` (outil `search_docs`)
- [x] Étape 7 — Frontend (frontend/) : Applications, recherche Serveur/IP, fiche appli à onglets, Architecture + simulation de panne, Synchronisation, Équipe, bulle de chat
- [ ] Rapport d'écarts : serveurs non supervisés, supervisés hors marketplace, cités dans Confluence mais inconnus

## Améliorations attendues du fetcher Confluence (hors Lyra)

`parentId` + `ancestors` ; `version.number` (aujourd'hui 0) ; `page.storage.xml` (`expand=body.storage`) ;
pièces jointes `.drawio` dans `attachments/` ; pour chaque image : nom d'origine, id de pièce jointe et `src` ;
`labels`, `fetchedAt` ; `tables[].headers` remplis quand la 1re ligne est en `<th>` ; ne pas nettoyer `page.html`.

## Contrat d'API (pour le frontend)

| Route | Usage écran |
|---|---|
| `GET /api/health` | statut + compteurs |
| `GET /api/config` | lien Naemon (`NAEMON_URL_TEMPLATE`), sources branchées |
| `GET /api/applications` | liste Applications (criticité, responsable, nb serveurs/bases, environnements) |
| `GET /api/applications/:id` | fiche appli : serverList, databaseList, callsList, usedBy, documents |
| `GET /api/servers?q=` | recherche Serveur / IP avec applications hébergées |
| `GET /api/teams` | page Équipe |
| `GET /api/search?q=` | recherche Application / Serveur / IP |
| `GET /api/nodes/:id` | fiche (attributs + liens entrants/sortants) |
| `GET /api/graph/:id?depth=2` | onglet Architecture (éléments cytoscape) |
| `GET /api/impact/:id?depth=&minConfidence=` | simulation d'impact |
| `GET /api/dependencies/:id` | dépendances |
| `GET /api/sync/runs`, `/api/sync/runs/:id/errors` | page Synchronisation |
| `POST /api/ask` `{question, history}` | bulle de chat (réponse : `answer`, `toolTrace`, `toolsMode`) |

Tickets / Changements / PRs : afficher « non connecté » tant que la source n'existe pas (jamais 0 trompeur).
