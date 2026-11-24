# Consignes pour l'assistant de code (OpenCode)

À lire en entier avant toute action dans ce dépôt.

## Ton rôle

Tu **installes, configures, lances et testes** Lyra sur ce poste, puis tu **rapportes** ce qui se passe.
Tu **ne développes pas** : toute modification du code passe par le responsable du projet, qui la fait
lui-même et la publie dans ce dépôt. Si quelque chose ne marche pas, tu ne corriges pas le code :
tu fais un rapport précis (voir « Rapporter un problème »).

Le projet est dans `v1/`. La documentation technique est dans `v1/ARCHITECTURE.md` (lisible, mais
elle décrit le code pour le comprendre, pas pour le modifier).

## Ce que tu as le droit de modifier

Uniquement ces fichiers, qui ne sont pas versionnés et propres à ce poste :

| Fichier | Rôle |
|---|---|
| `v1/backend/.env` | réglages du poste (créé depuis `.env.example` par `npm run setup`) |
| `v1/backend/config/perimeter.json` | les applications suivies |
| `v1/backend/config/mappings.json` | fichiers CSV et colonnes des exports |
| `v1/backend/data/raw/...` | dépôt des exports CSV (APM, marketplace) |
| `v1/logs/` | journaux des lancements |

Et seulement pour ce qui est demandé ci-dessous. Pour `perimeter.json` et `mappings.json`, tu proposes
la modification et tu attends l'accord de l'utilisateur avant de l'écrire.

## Ce que tu ne dois JAMAIS faire

- Modifier, créer, renommer ou supprimer un fichier dans :
  `v1/backend/src/`, `v1/backend/scripts/`, `v1/backend/test/`, `v1/frontend/src/`, `v1/scripts/`.
- Modifier `package.json`, `package-lock.json`, les fichiers `*.example*`, `README.md`, `ARCHITECTURE.md`,
  `opencode.md`, les `.gitignore`, les fichiers de test ou leurs données (`test/fixtures/`).
- Installer, mettre à jour ou supprimer un package : pas de `npm install <paquet>`, `npm update`,
  `npm audit fix`. Seul `npm run setup` est autorisé pour installer.
- Lancer `npm install` dans `v1/frontend/` sur ce poste (Node 16 : l'interface se compile ailleurs).
- Toute commande git qui écrit : `commit`, `push`, `merge`, `rebase`, `reset`, `checkout -- …`, `stash`,
  `clean`. Seuls `git pull` (sur demande), `git status`, `git log`, `git diff` sont autorisés.
- Contourner une erreur en changeant le code, en désactivant un test ou en ajoutant un « try/catch ».
- Afficher, recopier ou mettre ailleurs que dans `v1/backend/.env` un jeton, un mot de passe ou un cookie.
  Dans tes réponses, masque-les (`abcd…`).
- Mettre `HOST=0.0.0.0` dans `.env` sans demande explicite (le site serait visible depuis le réseau).
- Supprimer `v1/backend/data/` ou l'export Confluence sans demande explicite.
- Lancer une analyse IA complète (`sync:all`, `sync-confluence.js --llm` sans `--limit`) avant que
  l'essai sur 20 pages ait été validé par l'utilisateur.
- Inventer une valeur : URL, nom d'application, nom de modèle, clé d'espace Confluence. Si tu ne la
  trouves pas, demande-la.

## Mise en route, dans l'ordre

Toutes les commandes se lancent depuis `v1/`, sauf indication contraire.

1. **Vérifier Node** : `node -v` doit afficher `v16.20.x`.
2. **Installer** : `npm run setup`. Crée `backend/.env`, `backend/config/mappings.json` et
   `backend/config/perimeter.json` depuis les modèles s'ils n'existent pas (les existants sont gardés).
3. **Remplir `backend/.env`** : chaque variable y est commentée. Remplacer toutes les valeurs `<…>`.
   - `LLM_BASE_URL`, `LLM_TOKEN` : passerelle IA interne (mêmes valeurs que dans le projet lyrav2).
   - `LLM_MODEL_*` : noms exacts des modèles ; `npm run doctor` affiche ceux qui n'existent pas.
   - `CONFLUENCE_BASE_URL` : tout ce qui précède `/rest/api` dans les appels de lyrav2
     (par exemple `https://<hôte>/wiki` si les appels sont `https://<hôte>/wiki/rest/api/...`).
   - `CONFLUENCE_TOKEN` : jeton personnel Confluence de l'utilisateur (ou `CONFLUENCE_USER` / `CONFLUENCE_PASSWORD`).
   - `CONFLUENCE_SPACES` : clés des espaces ; la liste s'obtient avec
     `node backend/scripts/fetch-confluence.js --list-spaces`. Demander à l'utilisateur lesquels garder.
   - `MARKETPLACE_URL` : lien direct de téléchargement de l'export marketplace (fourni par l'utilisateur).
   - `MCP_*`, `NAEMON_URL_TEMPLATE` : laisser vides si non fournis.
4. **`backend/config/perimeter.json`** : les applications suivies, **fournies par l'utilisateur**
   (noms tels qu'écrits dans la colonne A de l'export APM). Ne jamais laisser les exemples OrderHub / Billing Engine.
5. **Export APM** : le fichier CSV fourni par l'utilisateur va dans `backend/data/raw/apm/`. Après une reprise de la v1, `data/raw/apm` et `marketplace`
   ne sont copiés qu'une fois : tout nouvel export doit être déposé dans `v2/backend/data/raw/apm` (ou `marketplace`), pas dans la v1.
   Vérifier que **la ligne 1 contient les en-têtes** (sinon le signaler, ne pas modifier le fichier).
6. **Contrôle** : `npm run doctor`. Objectif : `--- aucune erreur ---`. Les `WARN` sont à lister dans le rapport.
7. **Tests** : `npm test`. Tous les tests doivent passer (148 ou plus). Aucun ne nécessite le réseau.
8. **Essai sur 20 pages** (puis s'arrêter et montrer le résultat à l'utilisateur) :
   ```
   node backend/scripts/fetch-confluence.js --limit 20
   node backend/scripts/fetch-inventory.js
   node backend/scripts/sync-inventory.js
   node backend/scripts/sync-confluence.js --limit 20
   node backend/scripts/sync-confluence.js --llm --limit 20
   node backend/scripts/summarize-apps.js
   ```
   Regarder les rapports dans `backend/data/rapports/` (fichiers CSV) et résumer : pages par application,
   orthographes trouvées, noms proches non importés, pages d'architecture et leurs problèmes,
   et les résumés IA affichés sur la fiche des applications (pertinents ? inventés ?).
9. **Passage complet**, seulement après accord : `npm run sync:all` (le premier passage peut être long).
10. **Démarrer** : `npm start`, puis ouvrir `http://localhost:3001`. Si `frontend/dist` est absent,
    seule l'API répond : c'est normal, le signaler.

Les mêmes synchros se lancent depuis la page Synchronisation de l'interface ; ne pas en lancer une depuis
l'interface pendant qu'une autre tourne en ligne de commande (la seconde s'arrêtera sur « Une synchro tourne déjà »).

Les commandes ne refont que ce qui a changé : on peut les relancer sans risque. Si l'une s'arrête sur
« Une synchro tourne déjà », vérifier qu'aucune autre synchro n'est en cours avant de supprimer le
fichier `.sync.lock` indiqué.

## Erreurs fréquentes

| Message | Cause probable | Que faire |
|---|---|---|
| `valeurs d'exemple à remplacer (<…>)` | `.env` pas rempli | remplir les variables citées |
| `Invalid URL` / `URL invalide` | URL vide ou avec `<…>` | corriger dans `.env` |
| `HTTP 401` / `accès refusé` (Confluence) | jeton absent, faux ou expiré | demander un nouveau jeton à l'utilisateur |
| `Réponse non JSON … page de connexion` | mauvais `CONFLUENCE_BASE_URL` (préfixe `/wiki` ?) | comparer avec les appels de lyrav2 |
| `unable to get local issuer certificate` | certificat d'entreprise | variable système `NODE_EXTRA_CA_CERTS` (voir fin de `.env.example`) ; demander le chemin du certificat |
| `modèle … absent de /models` | nom de modèle inexact | reprendre le nom exact affiché par la passerelle |
| `page HTML reçue au lieu du fichier` (marketplace) | le lien demande une connexion | le signaler ; options `MARKETPLACE_TOKEN`, `_USER`/`_PASSWORD` ou `_COOKIE` dans `.env` |
| `classeur Excel (.xlsx) reçu` | le lien donne un .xlsx | le signaler (seul le CSV est lu) |
| `perimeter.json = exemple` | périmètre non rempli | demander la liste des applications |
| `Colonnes absentes de l'export` | colonnes différentes de `mappings.json` | lister les en-têtes du fichier dans le rapport ; ne pas modifier sans accord |
| `marketplace sautée : aucun fichier` | export marketplace pas encore là | normal tant que `MARKETPLACE_URL` est vide |

## Rapporter un problème

Quand une commande échoue ou qu'un résultat paraît faux, ne corrige rien et donne :

1. la commande exacte lancée et le dossier de lancement ;
2. la sortie complète (jetons et mots de passe masqués) ;
3. la sortie de `node -v` et de `npm run doctor` ;
4. le fichier et la ligne cités dans l'erreur s'il y en a ;
5. ton hypothèse sur la cause, en la présentant comme une hypothèse ;
6. ce que tu as déjà essayé (uniquement des changements de configuration autorisés).

Ce rapport est transmis au responsable du projet, qui fait la correction dans le code.

---

# Lyra v2 (dossier `v2/`)

Mêmes rôle, mêmes interdits et mêmes droits que pour la v1 (voir plus haut), en remplaçant `v1/` par `v2/` :
tu **installes, configures, lances et testes**, tu ne modifies jamais le code (`v2/backend/src/`, `v2/backend/scripts/`,
`v2/backend/test/`, `v2/frontend/` y compris `dist/`, `v2/scripts/`), ni `package.json`, ni les fichiers `*.example*`, ni les
fichiers de documentation. Tu ne touches jamais à `v1/` depuis la v2. Documentation : `v2/README.md` et `v2/ARCHITECTURE.md`.

Fichiers que tu peux modifier : `v2/backend/.env`, `v2/backend/config/perimeter.json`, `v2/backend/config/mappings.json`
et `v2/backend/config/consignes-ia.md` (pour ces trois derniers : proposition puis accord de l'utilisateur, jamais d'écriture
directe), `v2/backend/data/raw/...`, `v2/logs/`. Le modèle `consignes-ia.example.md` ne se modifie pas.

## Commandes (depuis `v2/`, Node 16.20.x)

| Commande | Rôle |
|---|---|
| `npm run setup` | installe le backend, crée `backend/.env` et les configs ; **reprend la v1** si `../v1/backend/.env` existe |
| `npm run doctor` | vérifie Node, IA, Confluence, Naemon, fichiers ; objectif : `--- aucune erreur ---` |
| `npm test` | tests du backend : tous les tests doivent passer (verts), sans réseau |
| `npm start` | http://localhost:3002 (interface incluse, car `frontend/dist` est dans le dépôt) |
| `npm run sync:all` | Confluence, CSV, analyse IA (seulement après l'essai sur 20 pages validé) |

Ne lance jamais `npm run build`, `npm run test:front` ni `npm install` dans `v2/frontend/` (Vite demande Node >= 22.12).
L'interface est déjà compilée dans `v2/frontend/dist` ; si elle manque, seule l'API répond : le signaler.

## Mise en route de la v2

1. `node -v` doit afficher `v16.20.x`.
2. `cd v2 && npm run setup`.
   - **Avec la v1 configurée à côté** : la reprise est automatique. Lire sa sortie et la citer dans le rapport : config copiée, cache IA,
     store, CSV, `.env` créé avec `PORT=3002`, `DEMO_MODE=false`, `CONFLUENCE_FETCH=false`. Relancer `setup` est sans risque (rien n'est écrasé).
   - **Sans v1** : `backend/.env` est créé avec **`DEMO_MODE=true`** (données fictives). Pour les vraies données, remplir `.env` comme pour la v1
     (voir plus haut) puis mettre `DEMO_MODE=false`.
3. Vérifier dans `v2/backend/.env` : `DEMO_MODE`, `PORT=3002`, `CONFLUENCE_EXPORT_DIR` (export de la v1 si `CONFLUENCE_FETCH=false`), `DATA_DIR`.
4. `npm run doctor`, puis `npm test` (tous les tests verts).
5. `npm start` et ouvrir http://localhost:3002. La v1 (3001) et la v2 (3002) peuvent tourner ensemble.

## Ce qu'on règle dans `.env` pour la v2

| Variable | Valeur |
|---|---|
| `DEMO_MODE` | `true` pour essayer sans données, `false` pour les vraies |
| `PORT` | `3002` (la v1 reste sur 3001) |
| `CONFLUENCE_FETCH` | `false` si la v1 récupère Confluence (reprise), `true` sinon |
| `HISTORY_KEEP` | nombre d'imports gardés dans l'historique (50 par défaut) |
| `NAEMON_SOURCE` | `off` (défaut), `thruk` ou `csv` |
| `NAEMON_THRUK_URL`, `NAEMON_TOKEN` ou `NAEMON_USER` et `NAEMON_PASSWORD` | pour `thruk` ; valeurs fournies par l'utilisateur, jamais inventées, masquées dans les rapports |
| `NAEMON_CSV_FILE` | pour `csv` ; les colonnes sont décrites dans le bloc `naemon` de `mappings.json` (proposer, attendre l'accord) |
| `NAEMON_POLL_MINUTES` | minutes entre deux relevés (5 par défaut) |
| `NAEMON_URL_TEMPLATE` | lien du bouton « Monitoring Naemon », `{app}` = nom de l'application |
| `LLM_REASONING_EFFORT` | `none` conseillé (modèle de `.env.example`) ; si la passerelle refuse ce réglage, Lyra le retire seul et l'écrit dans le journal |
| `LLM_MAX_TOKENS_REASONING` | place de réponse minimale par appel tant que la réflexion n'est pas coupée (réglage vide ou refusé), 8192 par défaut |
| `LLM_MAX_TOKENS_EXTRACT`, `READING_CHUNK_CHARS`, `CONSIGNES_FILE` | laisser les valeurs par défaut sauf demande |

`NODE_EXTRA_CA_CERTS` (certificat d'entreprise) se définit dans l'environnement **système**, pas dans `.env`.

## Lecture des pages par l'IA et consignes (v2)

L'IA lit chaque page Confluence et le code vérifie ses citations : plus aucune règle de repérage dans le code. Les conventions de
l'entreprise (noms de serveurs, sens de « recette », vocabulaire) se disent dans `v2/backend/config/consignes-ia.md`, absent au
départ (`npm run setup` ne le crée pas), à écrire à partir du modèle en remplaçant ses exemples fictifs. Tu peux proposer une modification de ce fichier, comme pour `perimeter.json`, et l'écrire
seulement après l'accord de l'utilisateur. Ne jamais y mettre de mot de passe, de jeton ni de donnée personnelle. Modifier les
consignes fait relire toutes les pages au prochain passage : le dire à l'utilisateur avant.

- `npm run doctor` indique la présence et la taille des consignes (au-delà de 8 000 caractères la fin est ignorée), les synonymes
  d'environnement lus dans `mappings.json` et le résultat d'une petite lecture d'essai.
- Au premier passage après la mise à jour (ou après une reprise de la v1), **toutes les pages sont relues par l'IA** : c'est normal et long.
  Toujours faire l'essai sur 20 pages d'abord : `node backend/scripts/sync-confluence.js --llm --limit 20`.
- Sans `--llm` ou sans IA joignable, les pages sont stockées mais rien n'est déduit (ni serveurs cités, ni responsables) : le signaler.
- Regarder dans `backend/data/rapports/` : `perimetre-pages.csv`, `perimetre-orthographes.csv`, `lectures-rejets.csv` (éléments écartés
  faute de citation ou d'application connue), `architecture-*.csv`. Les résumer dans le rapport.
- Page **Équipes** et carte **Responsables** de la fiche application : alimentées par les pages lues. Liens « À valider », « Ancien »,
  « Cible » et serveurs « Hors inventaire » : normaux, ils ne comptent pas (ou pas tous) dans l'impact.

## Erreurs fréquentes (v2)

| Message ou symptôme | Cause probable | Que faire |
|---|---|---|
| `Interface non disponible : frontend/dist absent` | dépôt incomplet ou `git pull` manquant | `git pull` (sur demande), sinon le signaler |
| Données fictives affichées (« Mode démo ») | `DEMO_MODE=true` | mettre `false` dans `.env`, relancer `npm start` |
| `EADDRINUSE` sur 3002 | une autre instance tourne | l'arrêter ; ne pas changer le port sans accord |
| `Thruk HTTP 401` ou `jeton ou identifiants refusés` | jeton Naemon faux ou expiré | demander un nouveau jeton |
| `Thruk : page HTML reçue (connexion ?)` | mauvaise URL Thruk ou authentification absente | comparer l'URL avec celle du navigateur (avec `/thruk`) |
| Supervision « inconnue » partout | `NAEMON_SOURCE=off` ou première relève pas encore faite | normal avec `off` ; sinon attendre un relevé et voir la page Supervision |
| Hôtes « non rapprochés » | noms Naemon différents de ceux de l'inventaire | les lister dans le rapport, ne rien modifier |
| `backend/.env existe déjà : reprise de la v1 ignorée` | `.env` créé avant la reprise | le dire à l'utilisateur ; ne pas supprimer le `.env` sans accord |
| `unable to get local issuer certificate` | certificat d'entreprise | `NODE_EXTRA_CA_CERTS` (variable système) |
| Réponses vides ou coupées de l'IA (`réponse vide`, `réponse coupée`, pages en erreur, doctor le signale) | le modèle « réfléchit » et épuise sa place | proposer `LLM_REASONING_EFFORT=none` dans `.env`, relancer `npm run doctor` puis l'essai sur 20 pages |
| `doctor` : consignes absentes, vides, trop longues ou « consignes d'exemple non adaptées » | `consignes-ia.md` manquant, > 8 000 caractères ou copie telle quelle du modèle | proposer de l'écrire à partir du modèle (exemples remplacés par les conventions de l'entreprise) ou de le raccourcir (accord de l'utilisateur) |
| Aucune équipe ni serveur cité après la synchro | pas de `--llm`, IA injoignable ou pages en erreur | lancer avec `--llm`, voir `lectures-rejets.csv` et le journal |
| Applications du périmètre toutes à « inconnu » après reprise | `perimeter.json` ou export APM absent | vérifier `data/raw/apm/` et `config/perimeter.json` |

Pour rapporter un problème : mêmes règles que pour la v1 (commande exacte, sortie complète sans secret, `node -v`, `npm run doctor`,
hypothèse présentée comme telle, ce qui a déjà été essayé).
