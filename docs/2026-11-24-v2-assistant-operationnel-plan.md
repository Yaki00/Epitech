# Lyra v2 : assistant opérationnel sur la documentation (plan de construction)

> Exécution : une tâche à la fois, relecture après chaque tâche, relecture de toute la branche à la fin.
> Étapes à cocher (`- [ ]`).

**Objectif :** à la synchro, l'IA écrit des fiches vérifiées (incident, correctif, procédure, bonne pratique) pour les
pages opérationnelles ; une recherche par mots-clés aidée du graphe les retrouve ; le chat gagne deux outils, cite ses
sources et ne garde que des liens venus des résultats ; l'interface montre les sources et les fiches de chaque
application ; le banc d'essai mesure tout cela sur des questions notées.

**Architecture :** nouveau dossier `v2/backend/src/knowledge/` (forme des fiches, consignes, lecture IA, vérification,
écriture dans le graphe, index de recherche, reclassement). La lecture actuelle (`src/reading/`) n'est pas modifiée ;
la synchro (`src/reading/syncPages.js`) appelle la lecture des fiches après elle, pour les pages opérationnelles. Les
fiches sont des nœuds `fiche` reliés par `concerne`, `vient_de`, `corrige`, jamais suivis par l'impact.

**Pile :** serveur Node 16.20 CommonJS, Express 4, jest ; interface React 19 / TypeScript / Vite 8 / Tailwind 4,
Vitest.

**Conception (autorité) :** `docs/2026-11-24-v2-assistant-operationnel-conception.md`. À lire avant chaque tâche ; en
cas de doute, elle l'emporte sur ce plan.

## Contraintes globales

- Serveur : Node 16.20.2 (pas de `fetch` global, `structuredClone`, `findLast`, `toSorted`, `Object.groupBy`, préfixe
  `node:`), Windows + Linux (`path.join`), CommonJS, **aucun paquet ajouté** (la recherche est écrite dans le projet).
- Tests serveur : `cd v2/backend && source ~/.nvm/nvm.sh && nvm exec 16.20.2 npm test` (383 tests verts au départ).
- Interface : `cd v2/frontend && npm test && npm run build` (Node 24) ; `dist/` versionné, recommité à la tâche 8.
- Dépôt PUBLIC : aucun nom interne d'entreprise ; exemples inventés ; aucune mention d'outil d'assistance au code dans
  fichiers, commits, PR ; commits en français **sans ligne d'attribution**.
- Typographie (interface, docs, commits, consignes) : jamais de tiret long ni de demi-cadratin.
- `v1/` n'est jamais modifié ; `src/reading/` seulement aux points dits (tâche 3).
- Lyra montre, n'agit jamais : aucune écriture vers Confluence, aucun ticket, aucune commande lancée.
- Aucun lien dans une réponse du chat qui ne vienne des résultats d'outils de la question.
- Aucun mot de passe, jeton, adresse électronique ni numéro de téléphone dans une fiche ou une réponse.
- Une fiche en échec ne fait jamais échouer la lecture de la page ni la synchro.
- Textes de l'interface en français et en anglais (`t()`, `src/lib/i18n.tsx`).

## Points d'attention (tests posés dans les tâches indiquées)

1. Question qui colle un long message d'erreur (pile de 3 000 caractères, guillemets, chemins, codes) : la recherche
   répond quand même et garde les mots techniques entiers (tâche 4, `long pasted error keeps technical tokens`).
2. Application écrite par son sigle ou avec une faute dans la question (« ONP », « Marele ») : reconnue et favorisée
   (tâche 4, `question app by sigle or typo`).
3. Étape de procédure qui contient un mot de passe ou un jeton (`mot de passe : Azerty12`, `token=abc...`) : l'élément est
   retiré de la fiche (tâche 2, `secret in a step is dropped`).
4. Deux procédures pour le même but, une ancienne et une récente : la récente d'abord, l'ancienne marquée (tâche 4,
   `recent procedure first, old one flagged`).
5. Aucune fiche encore (premier démarrage, IA absente, synchro jamais faite) : la recherche rend une liste vide sans
   erreur et l'assistant dit n'avoir rien trouvé (tâches 4 et 6, `empty index`).

---

### Tâche 1 : Forme des fiches, consignes et lecture IA

**Fichiers :** créer `src/knowledge/schema.js`, `src/knowledge/prompt.js`, `src/knowledge/readFiches.js`. Tests :
`test/knowledgeRead.test.js`.

**Interfaces :**
- Consomme : `chunkPage(input, chunkChars)` (`src/reading/readPage.js`), `llm.chatJson({ task, messages, schema,
  maxTokens })`, `consignes` (`{ text, hash }` de `loadConsignes`).
- Produit :
  - `FICHE_KINDS = ['incident', 'correctif', 'procedure', 'pratique']` ; `OPS_KINDS = ['incident', 'release',
    'operations', 'install', 'other']` (natures de page qui reçoivent la lecture des fiches).
  - Forme d'une fiche lue (`FicheReading`) : `{ kind, title: Item, section: string|null, date: Item|null, fields: {
    [nom]: Item }, lists: { [nom]: Item[] }, apps: Item[], servers: Item[], keywords: string[], replaces: Item|null,
    fixes: Item|null }` avec `Item = { text, evidence }`. Champs par type : `incident` : fields `symptoms`, `cause`,
    `solution` ; lists `errors`, `actions`, `tickets`. `correctif` : fields `version` ; lists `tickets`. `procedure` :
    fields `goal`, `when`, `prerequisites`, `cautions` ; lists `steps`. `pratique` : lists `rules`.
  - `sanitizeFiches(raw) -> { fiches: FicheReading[] }`, `mergeFicheReadings(list) -> { fiches }` (concaténation des
    morceaux, doublons même type + même titre normalisé fusionnés).
  - `OPS_VERSION = 1` ; `buildFicheMessages({ title, ancestors, today, kind, text, apps, consignes, part })`.
  - `readFiches(llm, input, { chunkChars, maxTokens }) -> Promise<{ fiches }>`, même entrée que `readPage` plus
    `kind` (nature lue de la page).

- [ ] **Étape 1 : tests** `sanitize keeps allowed kinds and fields only`, `item without evidence is dropped`,
  `keywords are capped to 12 short strings`, `merge of chunks fuses same kind and title`, `readFiches calls the
  model once per chunk with the page kind`, `empty answer gives no fiche` (lecteur simulé par `createLlmClient` en
  mode `mock`, comme `test/reading.test.js`).
- [ ] **Étape 2 : lancer** `nvm exec 16.20.2 npx jest test/knowledgeRead.test.js` : échec (modules absents).
- [ ] **Étape 3 : écrire** les trois modules. Consignes système : rendre seulement ce qui est écrit, une citation mot
  pour mot par élément, solution et étapes telles qu'écrites (jamais complétées), messages d'erreur recopiés
  exactement, plusieurs fiches par page si la page en contient plusieurs (une par correction d'une note de version, une
  par procédure d'un dossier), `replaces` seulement si la page dit remplacer une autre procédure, `fixes` seulement si
  une correction cite un incident, `keywords` : formulations qu'un utilisateur emploierait (jamais montrées comme des
  faits). Le système porte le périmètre et les consignes de l'entreprise comme `src/reading/prompt.js`.
- [ ] **Étape 4 : relancer** : vert ; `npm test` complet vert.
- [ ] **Étape 5 : commit** « Fiches : forme, consignes et lecture IA ».

### Tâche 2 : Vérification des fiches

**Fichiers :** créer `src/knowledge/verify.js`. Tests : `test/knowledgeVerify.test.js`.

**Interfaces :**
- Consomme : `hasEvidence`, `quoteNames`, `normalizeText` (`src/reading/evidence.js`), `matcher.resolveAppName`,
  `repo.resolve`.
- Produit : `verifyFiches(reading, ctx) -> { fiches: VerifiedFiche[], rejected: [{ what, reason }] }` avec `ctx = {
  pageText, repo, matcher }` et `VerifiedFiche = { kind, title, section, date, fields: { nom: Item }, lists: { nom:
  Item[] }, appIds: string[], serverIds: string[], tickets: string[], keywords: string[], replaces: Item|null, fixes:
  Item|null }`.

- [ ] **Étape 1 : tests** `item kept only when its quote is in the page`, `fiche without verified title is dropped`,
  `apps and servers resolved like the reading, unknown names kept as text only`, `tickets kept as written and
  deduplicated`, `secret in a step is dropped` (`mot de passe : Azerty12`, `password=xyz`, `token: abc123`, `jeton :
  ...` : l'élément entier est retiré, raison `secret`), `email and phone never kept`.
- [ ] **Étape 2 : lancer** : échec.
- [ ] **Étape 3 : écrire** `verifyFiches`. Raisons de rejet : `no_evidence`, `evidence_mismatch` (citation qui ne
  contient pas le texte ni un mot de 4 lettres ou plus de l'élément), `secret`, `out_of_scope`. Le filtre de secrets
  est une protection, comme les adresses électroniques : motif `(mot de passe|password|passwd|pwd|token|jeton|secret|
  api[ _-]?key)\s*[:=]\s*\S+`, insensible à la casse.
- [ ] **Étape 4 : relancer** : vert ; `npm test` vert.
- [ ] **Étape 5 : commit** « Fiches : vérification par citation, secrets retirés ».

### Tâche 3 : Fiches dans le graphe et dans la synchro

**Fichiers :** créer `src/knowledge/apply.js` ; modifier `src/reading/syncPages.js` (appel des fiches, empreinte,
fin de passage), `src/graph/impact.js` (`NON_PROPAGATING`), `src/store/repo.js` (`search` ignore `fiche`),
`src/api/views.js` et la carte si elles parcourent tous les liens. Tests : `test/knowledgeSync.test.js`,
`test/graph.test.js` (complété).

**Interfaces :**
- Consomme : `readFiches`, `verifyFiches`, `OPS_KINDS`, `OPS_VERSION`.
- Produit :
  - `applyFiches(repo, verified, { pageId, docNodeId, page: { title, url, updatedAt }, period }) -> { fiches }` :
    nœuds `fiche:<pageId>-<n>` (type `fiche`, source `llm`, `attrs` = `{ kind, title, section, url, pageId, docId,
    period, updatedAt, fields, lists, tickets, keywords, replaces, fixes, replacedBy: null }`) ; liens `concerne`
    (fiche vers application ou serveur) et `vient_de` (fiche vers document), source `knowledge`, `sourceRef` =
    `pageId`. Relecture : liens `knowledge` de la page purgés, nœuds en trop marqués `retired`.
  - `linkFiches(repo) -> { corrige, remplacees }` (fin de passage) : `corrige` (correctif vers incident) quand ils
    partagent un ticket, ou quand `fixes` nomme le titre d'un incident (mots normalisés) ; `replaces` résolu d'abord par
    le lien Confluence cité, sinon même application et but aux mêmes mots normalisés ; la procédure trouvée reçoit
    `replacedBy` (id) et la citation.
  - Attributs document : `opsHash`, `opsContentHash`, `ficheCount` dans la ligne document.
  - Lien d'une fiche : `url` de la page, suivi de `#<ancre>` quand la section a un identifiant dans `page.html` ; sinon
    le lien de la page seul, la section étant donnée par son titre.
  - Sections pour la recherche de second recours : la synchro écrit `<DATA_DIR>/knowledge-sections.json` (`[{ pageId,
    title, url, section, text, period }]`, toutes les pages lues, texte barré exclu, page retirée absente), réécrit à
    chaque passage.
  - `NON_PROPAGATING` contient aussi `concerne`, `vient_de`, `corrige`.

- [ ] **Étape 1 : tests** `ops page gets fiches after its reading`, `non ops page gets none`, `fiche failure keeps the
  page reading and counts an error`, `second pass without change makes no AI call`, `consignes change re-reads fiches
  only` (lecture des pages non rappelée), `fewer fiches on re-read retires the extra ones`, `ticket shared links
  correctif to incident`, `replaces marks the older procedure`, `impact never follows fiche links`, `entity search
  ignores fiches`.
- [ ] **Étape 2 : lancer** : échec.
- [ ] **Étape 3 : écrire** `applyFiches`, `linkFiches` ; dans `runConfluenceSync`, après `applyAndSave` d'une page lue
  dont la nature (`verified.kind`) est dans `OPS_KINDS` : `readFiches` puis `verifyFiches` puis `applyFiches`, avec
  `opsHash = sha256(OPS_VERSION | consignes.hash | matcher.hash)` ; une page dont la lecture est à jour mais pas les
  fiches ne relance que les fiches ; erreur des fiches : `stats.ficheErrors++`, journal, page non marquée en erreur.
  `linkFiches` après `recheckPages()`. Statistiques ajoutées : `fiches`, `ficheErrors`.
- [ ] **Étape 4 : relancer** : vert ; `npm test` vert.
- [ ] **Étape 5 : commit** « Fiches : écriture dans le graphe et branchement dans la synchro ».

### Tâche 4 : Recherche

**Fichiers :** créer `src/knowledge/search.js` ; modifier `src/api/app.js` (index construit au démarrage, reconstruit
quand `repo.reloadIfChanged()` recharge le store après une synchro, routes). Tests : `test/knowledgeSearch.test.js`,
`test/api2.test.js` (complété).

**Interfaces :**
- Consomme : nœuds `fiche`, `repo`, `matcher` (`scanText`), `repo.resolve`, `knowledge-sections.json` (tâche 3).
- Produit :
  - `buildKnowledgeIndex(repo, { sections }) -> KnowledgeIndex` ; `searchKnowledge(index, repo, matcher, { query,
    application, limit = 10, now }) -> { fiches: Hit[], sections: SectionHit[], apps: string[] }` avec `Hit = { id,
    kind, title, appNames, period, updatedAt, url, section, excerpt, score, old, replaced, otherApplication }` et
    `SectionHit = { pageId, title, section, url, excerpt, score }` (cinq au plus).
  - Routes : `GET /api/knowledge/search?q=&app=` (même résultat) ; `GET /api/applications/:id` gagne `knowledge: [{
    id, kind, title, period, updatedAt, url, old, replaced }]` (fiches qui la concernent, plus récentes d'abord) ;
    `GET /api/knowledge/:id` rend la fiche complète.
- Algorithme : BM25 (`k1 = 1.2`, `b = 0.75`) sur les champs de la fiche, titre et mots de recherche comptés deux fois ;
  mots normalisés comme `normalizeText`, plus les mots techniques gardés entiers (suites contenant chiffre, point,
  souligné ou tiret, comme `Q.MRL.EVT`, `ORA-01555`, `lmrlp01`). Applications de la question : `scanText` + `resolve`
  + argument `application`. Bonus multiplicatifs, réglables dans le module : fiche de l'application ×1,5, d'une voisine
  ×1,2 ; procédure ou pratique ancienne ×0,5, remplacée ×0,3 ; à 5 % près, la plus récente d'abord. Voisines :
  liens actifs `calls`, `depends_on`, `reads_from`, `writes_to` dans les deux sens, et applications qui partagent un
  serveur, une base ou une file actifs. `otherApplication` vrai quand la question nomme une application et que la fiche
  ne la concerne pas.

- [ ] **Étape 1 : tests** `error message finds the incident`, `long pasted error keeps technical tokens`, `question
  app by sigle or typo`, `app fiches before neighbour fiches before others`, `shared server makes a neighbour`, `recent
  procedure first, old one flagged`, `replaced procedure flagged and last`, `incident and correctif never flagged old`,
  `section hit when no fiche matches`, `empty index`, `other application flagged`, `GET /api/knowledge/search`,
  `application detail lists its fiches`.
- [ ] **Étape 2 : lancer** : échec.
- [ ] **Étape 3 : écrire** `search.js` et les routes ; index construit au démarrage et à chaque rechargement du store
  (fichier de sections absent : fiches seules, sans erreur).
- [ ] **Étape 4 : relancer** : vert ; `npm test` vert.
- [ ] **Étape 5 : commit** « Fiches : recherche par mots-clés aidée du graphe ».

### Tâche 5 : Reclassement facultatif

**Fichiers :** créer `src/knowledge/rerank.js` ; modifier `src/config.js`, `scripts/doctor.js`, `backend/.env.example`,
`src/knowledge/search.js`. Tests : `test/knowledgeSearch.test.js` (complété), `test/llm.test.js` si `llmClient` gagne
`rerank`.

**Interfaces :**
- Produit : config `knowledge: { rerank: bool('KNOWLEDGE_RERANK', false), rerankPath: env('KNOWLEDGE_RERANK_PATH',
  '/rerank') }` ; `llm.rerank({ query, documents }) -> number[]` (scores, même ordre) : POST `{ model:
  modelFor('rerank'), query, documents }`, réponse `results[].index` et `relevance_score`. `searchKnowledge` accepte
  `rerank: async (query, texts) => scores` et l'applique aux vingt premiers ; échec du reclassement : ordre gardé,
  avertissement une fois.
- [ ] **Étape 1 : tests** `rerank off by default`, `rerank reorders the first twenty`, `rerank failure keeps order`,
  `doctor tries rerank only when enabled`.
- [ ] **Étape 2 : lancer** : échec. **Étape 3 : écrire.** **Étape 4 : relancer** : vert ; `npm test` vert.
- [ ] **Étape 5 : commit** « Fiches : reclassement facultatif par la passerelle ».

### Tâche 6 : Assistant (outils, consignes, contrôle des liens)

**Fichiers :** modifier `src/assistant/ask.js`, `src/api/app.js` (index et matcher passés à `ask`). Tests :
`test/askTools.test.js`, `test/llm.test.js` (scénarios de chat).

**Interfaces :**
- Consomme : `searchKnowledge`, `GET`-équivalent interne pour ouvrir une fiche.
- Produit :
  - Outils `search_knowledge(query, application?)` (rend `fiches` et `sections` de `searchKnowledge`) et
    `open_fiche(id)` (fiche complète : champs, listes, citations, lien, section, `old`, `replaced`,
    `otherApplication`), en mode natif et en mode JSON.
  - `ask(...)` rend `{ answer, toolTrace, toolsMode, sources: [{ id, kind, title, url, appNames, old, replaced,
    otherApplication }], removedLinks: string[] }`.
  - Contrôle : toute URL (`http(s)://...`) de la réponse absente des URL rendues par les outils de cette question
    (comparaison sans `/` final ni ancre) est retirée du texte et listée dans `removedLinks`. `sources` = fiches
    ouvertes, plus celles dont l'URL figure dans la réponse.
- Consignes ajoutées (FR et EN) : chercher avant toute question de dépannage, de procédure ou de pratique ; donner la
  solution ou les étapes comme la fiche les donne ; citer titre et lien de chaque source ; dire « ancienne »,
  « remplacée », « autre application » quand c'est le cas ; dire clairement quand rien n'a été trouvé ; ne jamais
  compléter une étape de mémoire.

- [ ] **Étape 1 : tests** `troubleshooting question calls search then open`, `answer keeps only links from tool
  results`, `trailing slash and anchor do not count as different links`, `sources list the opened fiches`, `nothing
  found says so` (index vide : réponse sans lien, `sources` vide), `json tools mode offers the two new tools`.
- [ ] **Étape 2 : lancer** : échec. **Étape 3 : écrire.** **Étape 4 : relancer** : vert ; `npm test` vert.
- [ ] **Étape 5 : commit** « Assistant : recherche dans la documentation, sources et liens contrôlés ».

### Tâche 7 : Mode démo

**Fichiers :** modifier `src/demo/generate.js`, `src/demo/chatMock.js`. Tests : `test/demo.test.js`.

- [ ] **Étape 1 : tests** `demo has fiches of each kind linked to applications`, `demo chat answers a procedure
  question with sources`.
- [ ] **Étape 2 : lancer** : échec. **Étape 3 : écrire** : une à trois fiches inventées par type, rattachées aux
  applications de la démo, dont une procédure ancienne remplacée ; `chatMock` répond aux questions « comment… »,
  « erreur… », « incident… » par une fiche trouvée avec `searchKnowledge`, avec `sources`. **Étape 4 : relancer** :
  vert ; `npm test` vert.
- [ ] **Étape 5 : commit** « Démo : fiches et réponses avec sources ».

### Tâche 8 : Interface

**Fichiers :** modifier `v2/frontend/src/lib/api.ts` (types `AskResult.sources`, `removedLinks`,
`ApplicationDetail.knowledge`, `KnowledgeHit`), `src/components/Chat.tsx`, `src/pages/Application.tsx` (onglet
`docs` : bloc « Documentation opérationnelle »), `src/lib/i18n.tsx` (clés FR et EN). Tests : `src/lib/chat.test.ts`,
nouveau `src/lib/knowledge.test.ts`.

- [ ] **Étape 1 : tests** (Vitest) : `sources render kind, title, app and date`, `old, replaced and other application
  badges`, `knowledge block groups by kind, newest first`, `no knowledge shows an empty state`.
- [ ] **Étape 2 : lancer** `npm test` : échec. **Étape 3 : écrire** : cartes de sources sous chaque réponse du chat
  (lien vers la page dans un nouvel onglet) ; bloc de l'onglet Documentation : procédures, incidents, correctifs,
  bonnes pratiques, avec badges. **Étape 4 : relancer** `npm test && npm run build` : vert.
- [ ] **Étape 5 : commit** « Interface : sources du chat et documentation opérationnelle » (avec `dist/`).

### Tâche 9 : Documentation et livraison

**Fichiers :** `v2/README.md`, `v2/ARCHITECTURE.md`, `opencode.md`, `backend/.env.example`.

- [ ] **Étape 1 :** README : ce que fait l'assistant, exemples de questions, réglages (`KNOWLEDGE_RERANK`), coût du
  premier passage. ARCHITECTURE : forme des fiches, liens, recherche, contrôle des liens, API. opencode.md : commandes,
  nombre de tests, erreurs fréquentes (fiches en échec, reclassement refusé).
- [ ] **Étape 2 :** `npm test` (serveur) et `npm test && npm run build` (interface) verts ; recherche des tirets longs
  et des noms internes dans le diff : aucun.
- [ ] **Étape 3 : commit** « Documentation : assistant opérationnel ».

### Tâche 10 : Banc d'essai (hors dépôt, `~/Documents/code/Lyra-banc-essai`)

**Fichiers :** `generateur/pages.js` (nouvelles familles), `generateur/monde.js` si besoin, `verite/` (fiches
attendues), `notation/noter.js` (section « Documentation opérationnelle »), `notation/questions-ops.json` (nouveau),
`notation/avant-apres.js`, `REPRISE.md`.

- [ ] **Étape 1 : pages** : procédures (relance, purge de file, rotation de certificat, bascule de reprise, restauration,
  accès d'astreinte), dont deux doublons proches pour deux applications, une procédure remplacée par une plus récente
  qui le dit, et des applications sans certaines procédures ; incidents avec messages d'erreur, cause, solution,
  tickets ; notes de version dont une correction cite le ticket d'un incident ; tutos et bonnes pratiques ; pages de
  bruit aux mêmes mots. Vérité : fiches attendues par page (type, titre, éléments clés, application).
- [ ] **Étape 2 : questions** : environ quarante dans `questions-ops.json` : `{ question, attendu: { pageId | null,
  ficheTitre?, elements: [...], lien: true|false } }`, dont au moins huit « rien à trouver », six messages d'erreur
  collés, six « procédure similaire ».
- [ ] **Étape 3 : notation par le code** : recherche (`GET /api/knowledge/search` sur la question brute : bonne source
  dans les trois premiers), réponse (`/api/ask` : bon lien et éléments attendus, « rien trouvé » reconnu), `removedLinks`
  comptés, procédure ancienne ou d'une autre application présentée comme la bonne (badge absent dans la réponse) :
  0 attendu ; fiches lues contre la vérité ; mesures actuelles inchangées.
- [ ] **Étape 4 : passage** complet (Ollama direct, puis par la fausse passerelle), tableau des objectifs de la
  conception, `REPRISE.md` à jour.

---

## Ordre et dépendances

1 → 2 → 3 → 4 → (5, 6 en parallèle possible) → 7 → 8 → 9 ; 10 peut commencer dès la tâche 1 (pages et questions) et se
termine après la 9.
