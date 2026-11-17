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
5. **Export APM** : le fichier CSV fourni par l'utilisateur va dans `backend/data/raw/apm/`.
   Vérifier que **la ligne 1 contient les en-têtes** (sinon le signaler, ne pas modifier le fichier).
6. **Contrôle** : `npm run doctor`. Objectif : `--- aucune erreur ---`. Les `WARN` sont à lister dans le rapport.
7. **Tests** : `npm test`. Tous les tests doivent passer (135 ou plus). Aucun ne nécessite le réseau.
8. **Essai sur 20 pages** (puis s'arrêter et montrer le résultat à l'utilisateur) :
   ```
   node backend/scripts/fetch-confluence.js --limit 20
   node backend/scripts/fetch-inventory.js
   node backend/scripts/sync-inventory.js
   node backend/scripts/sync-confluence.js --limit 20
   node backend/scripts/sync-confluence.js --llm --limit 20
   ```
   Regarder les rapports dans `backend/data/rapports/` (fichiers CSV) et résumer : pages par application,
   orthographes trouvées, noms proches non importés, pages d'architecture et leurs problèmes.
9. **Passage complet**, seulement après accord : `npm run sync:all` (le premier passage peut être long).
10. **Démarrer** : `npm start`, puis ouvrir `http://localhost:3001`. Si `frontend/dist` est absent,
    seule l'API répond : c'est normal, le signaler.

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
