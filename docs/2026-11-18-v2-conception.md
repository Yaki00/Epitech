# Lyra v2 : conception

Date : 18/11/2026. Statut : validé le 18/11/2026.

## Intention

Lyra répond à « si je touche X, qu'est-ce qui est impacté ? » pour un périmètre d'une douzaine
d'applications, à partir de Confluence, de l'APM et de la marketplace. La v1 fonctionne mais reste
statique : elle ne sait pas ce qui est en panne maintenant, son interface est fonctionnelle sans plus,
et un serveur retiré d'un inventaire y reste pour toujours.

La v2 vise un outil **moderne et propre** qui ajoute la supervision en direct (Naemon), un tableau de
bord, une cartographie lisible et un historique, **sans rien changer à la façon de l'installer au
travail** : sur le poste, on récupère le dépôt, on lance une commande, et la configuration de la v1
est reprise. Les données sont simulées tant que les vraies sources ne sont pas branchées.

## Objectifs

1. Dossier `v2/` autonome à côté de `v1/` (la v1 continue de tourner au travail, inchangée).
2. Passage v1 → v2 sans modification manuelle : `npm run setup` reprend `.env`, `config/*.json`,
   les exports et le cache IA de la v1.
3. Mode démo complet (`DEMO_MODE=true`) : toutes les pages remplies avec un jeu fictif cohérent,
   aucun appel réseau.
4. Naemon : état en direct, propagation de l'impact réel, rapport d'écarts.
5. Interface refaite : tableau de bord, cartographie React Flow + ELK, simulation de panne,
   recherche Ctrl+K, fiche serveur, thème clair / sombre, FR / EN.
6. Historique des synchros (ajouts / retraits) et retrait des éléments disparus des inventaires.
7. Score de documentation par application.

## Hors périmètre (v2)

- ServiceNow, Bitbucket : restent « non connecté » (jamais un 0 trompeur).
- Analyse des images Confluence (étape 3 de la v1), recherche documentaire par embeddings.
- Comptes utilisateurs, authentification, base de données SQL.
- Toute modification de `v1/`.

## À ne jamais faire (anti-objectifs)

- Exiger une modification de code ou de fichier versionné sur le poste du travail.
- Casser la compatibilité Node 16.20 du serveur, ajouter un paquet au serveur.
- Écrire un nom interne d'entreprise (URL, sigle, nom d'application réel, numéro) dans le dépôt :
  il est **public**. Le jeu de démo est entièrement inventé.
- Mentionner un outil d'assistance au code dans les fichiers, commits ou PR.
- Laisser l'IA calculer un impact : l'impact et les états viennent du graphe et de Naemon.

## Contraintes

- **Serveur** : Node 16.20.2, Windows et Linux, CommonJS, liste de paquets fermée (celle de la v1 :
  express, dotenv, cheerio rc.12, cors, body-parser, node-html-parser ; dev : jest, supertest).
  Toutes les règles Node 16 de `v1/ARCHITECTURE.md` s'appliquent (pas de `fetch` global, etc.).
- **Interface** : compilée sur une machine Node ≥ 22.12 (le Mac), servie en fichiers statiques par
  le serveur. Le poste n'exécute jamais Vite.
- **Navigateur du poste** : Edge / Chrome récents (Windows d'entreprise, mis à jour automatiquement).
- Le poste est piloté par un assistant qui **ne modifie pas le code** (`opencode.md`) : tout doit
  se régler par `.env` et `config/*.json`, avec des messages d'erreur explicites (`npm run doctor`).

## Approches envisagées

| | Approche | Bilan |
|---|---|---|
| **A (retenue)** | Copier le serveur de la v1 dans `v2/` et le faire évoluer ; refaire l'interface entièrement | Garde 148 tests et les pièges Node 16 déjà réglés ; seule l'interface repart de zéro |
| B | Tout réécrire en TypeScript, serveur compris | Plus homogène, mais perd une logique éprouvée sur le vrai poste et ajoute une compilation du serveur |
| C | Faire évoluer `v1/` sur place | Exclu : la v1 doit continuer de tourner au travail |

Choix de l'utilisateur : A, avec toutes les fonctionnalités proposées.

## Conception

### Arborescence

```
v2/
  package.json          setup, start, doctor, sync:all, test, build (comme la v1)
  scripts/              setup.js (reprise v1), start.js, sync-all.js
  backend/              copie de v1/backend puis évolutions
    src/naemon/         nouvelles sources d'état (thruk, csv, mock) + rapprochement
    src/demo/           générateur du jeu de démo
    src/history/        instantanés et différences entre synchros
    src/quality/        score de documentation
  frontend/             nouvelle interface (TypeScript)
    dist/               interface compilée, VERSIONNÉE (voir plus bas)
  README.md, ARCHITECTURE.md
```

Le serveur v2 garde les mêmes noms de variables `.env` que la v1. Les nouvelles variables sont
toutes facultatives, avec une valeur par défaut qui marche.

### Reprise de la v1 (`npm run setup`)

Si `v2/backend/.env` n'existe pas et que `../v1/backend/.env` existe :

1. copie `.env`, `config/perimeter.json`, `config/mappings.json` de la v1 ;
2. met `PORT=3002` (les deux versions peuvent tourner en même temps) ;
3. pointe `CONFLUENCE_EXPORT_DIR` vers l'export de la v1 (chemin absolu) et met
   `CONFLUENCE_FETCH=false` : la v2 **lit** cet export mais ne le récupère jamais (seule la v1
   l'écrit ; pas de récupération concurrente). `fetch:confluence` et le bouton correspondant
   expliquent pourquoi ils sont coupés ;
4. copie le cache IA de la v1 dans celui de la v2 (pas de dossier partagé en écriture) : les
   prompts d'extraction sont repris tels quels, donc le cache sert et aucun appel IA n'est refait
   pour ce qui est déjà analysé ;
5. copie le store de la v1 (`DATA_DIR`) : la v2 affiche les vraies données dès le premier
   `npm start`, sans synchro ; la première synchro v2 ajoute ensuite l'historique et Naemon ;
6. copie `data/raw/apm` et `data/raw/marketplace` (petits fichiers) ;
7. ajoute à la fin du `.env` le bloc commenté des nouvelles variables v2 ;
8. n'écrase jamais un fichier existant ; affiche ce qu'il a fait.

Sans v1 à côté : comportement de la v1 (copie des `*.example*`). `DEMO_MODE=true` dans
`.env.example` pour qu'une installation neuve affiche directement quelque chose.

`frontend/dist` est **versionné** dans `v2/` : sur le poste, un `git pull` suffit pour avoir la
nouvelle interface. Il ne contient que du code déjà public.

### Mode démo

- `DEMO_MODE=true` : au démarrage, le serveur génère (de façon déterministe, graine fixe) un graphe
  fictif dans `data/demo-store/` (jamais mélangé avec `DATA_DIR`) : 12 applications du périmètre
  + 4 hors périmètre, ~80 serveurs (PRD / STG / DEV), bases, flux entre applications, pages de
  documentation fictives (dont des pages d'architecture avec et sans écarts), 3 synchros
  d'historique avec ajouts et retraits, et des états Naemon variés (quelques pannes et alertes).
- Naemon en démo : les états évoluent légèrement à chaque relève (une alerte apparaît, une autre
  disparaît) pour que l'écran « en direct » ait l'air vivant.
- Chat en démo : réponses de l'IA simulées (mécanisme `LLM_MOCK` existant), clairement marquées.
- Boutons de synchro en démo : désactivés, avec la mention « mode démo ».
- Un bandeau discret « Données de démonstration » est affiché partout.

### Naemon

Variables : `NAEMON_SOURCE=off|thruk|csv` (défaut `off` ; forcé à `mock` en démo),
`NAEMON_THRUK_URL` (ex. `https://<naemon>/thruk`), `NAEMON_TOKEN` (en-tête `X-Thruk-Auth-Key`) ou
`NAEMON_USER` / `NAEMON_PASSWORD` (Basic), `NAEMON_CSV_FILE` (motif `*` accepté, comme les
inventaires), `NAEMON_POLL_MINUTES=5`, `NAEMON_URL_TEMPLATE` (lien existant, gardé).

- **Thruk** : `GET {url}/r/hosts?columns=name,address,state,plugin_output,last_check,groups,acknowledged,scheduled_downtime_depth` et
  `GET {url}/r/services?columns=host_name,description,state,plugin_output,last_check,acknowledged,scheduled_downtime_depth`, via
  `lib/httpFetch.js` (certificat d'entreprise : `NODE_EXTRA_CA_CERTS`, comme le reste).
- **CSV** : export Thruk (une ligne par hôte ou service), colonnes déclarées dans un bloc `naemon`
  de `mappings.json` (même syntaxe lettres / en-têtes que l'APM).
- Relève dans le processus serveur toutes les N minutes ; dernier état gardé en mémoire et dans
  `naemon-status.json` (le serveur redémarre avec le dernier état connu, horodaté).
- **Rapprochement** hôte Naemon → serveur du graphe par `repo.resolve` (nom court, FQDN, IP).
  Thruk renvoie tous les hôtes de l'entreprise : seuls les hôtes rapprochés d'un serveur connu
  sont gardés, plus ceux dont un hostgroup correspond à une application du périmètre (même
  reconnaissance des noms, sigles et fautes que `perimeter.json`, plus un champ facultatif
  `naemonHostgroups` par application). Le reste est ignoré.
- **État d'un serveur** : `ok`, `warning`, `critical`, `down`, `unknown`, `maintenance`,
  `not_monitored`. L'état de l'hôte prime ; sinon le pire de ses services. `UNREACHABLE` → `unknown`.
  Une maintenance planifiée (`scheduled_downtime_depth > 0`) donne `maintenance` : ce n'est pas
  une panne et elle ne propage rien. Une alerte acquittée garde son état mais est affichée
  « prise en charge ».
- **État d'une application** (par environnement, PRD puis STG ; DEV ignoré par défaut) :
  `down` si tous ses serveurs de l'environnement sont `down`/`critical` ; `degraded` si au moins
  un serveur est en `warning`/`critical`/`down` ; `ok` sinon ; `unknown` si aucun serveur supervisé.
  La redondance réelle n'étant pas connue, « une partie des serveurs en panne » donne `degraded`,
  pas `down`.
- **Impact réel** : les applications qui dépendent (graphe, `calls` / `uses_db`) d'une application
  `down` ou `degraded` sont marquées `at_risk`, avec le chemin qui l'explique (même parcours que
  `graph/impact.js`). Cela ne modifie pas le graphe stocké.
- **Rapport d'écarts** (page Supervision + CSV dans `REPORTS_DIR`) : serveurs du périmètre non
  supervisés ; hôtes supervisés inconnus des inventaires ; serveurs cités dans Confluence mais
  absents des inventaires (déjà partiellement calculé par `perimeter/architecture.js`).

### Historique et retraits

- À chaque import d'inventaire réussi (fichier lu en entier), on compare l'ensemble des clés vues
  pour cette source avec l'import précédent : ajouts, retraits, attributs modifiés (IP, OS, RAM…).
- Le résultat est écrit dans `changes.json` (dans `DATA_DIR`, `HISTORY_KEEP=50` imports gardés).
- Un nœud qui n'est plus fourni par **aucune** source d'inventaire est marqué
  `attrs.retired = true`, `retiredAt` : grisé dans l'interface, exclu de l'impact par défaut
  (option « inclure les retirés »). Il redevient actif s'il réapparaît. Rien n'est supprimé.
- Même règle pour les **liens** venus d'un inventaire (`runs_on`…) : un lien que la source ne
  fournit plus est marqué retiré. Un serveur passé de l'application A à B n'impacte donc plus A.
- La présence se juge sur **tout le fichier**, avant le filtre du périmètre : retirer une
  application de `perimeter.json` la fait sortir du périmètre, pas « disparaître ».
- Import partiel ou en erreur : aucun retrait (on ne déduit rien d'un fichier incomplet).

### Score de documentation

Calculé à la volée par application, sur 100, avec le détail affiché :

| Critère | Points |
|---|---|
| Au moins une page d'architecture | 35 |
| Pages d'architecture sans écart avec les inventaires | 25 |
| Part des serveurs de l'application cités dans la documentation | 30 |
| Résumé disponible | 10 |

Responsable et équipe support : écartés (aucune source aujourd'hui, choix de l'utilisateur).

### Données réelles (réponses de l'utilisateur, 18/11)

- L'APM donne trois environnements : dev, stg, prd.
- Criticité = colonne AI (« confidentiality » dans le mapping de la v1) ; exposée en
  `criticality` dans l'API et l'interface.
- Responsable et équipe support : non renseignés, on les oublie dans la v2.

### API (ajouts ; les routes v1 restent identiques)

| Route | Usage |
|---|---|
| `GET /api/overview` | tableau de bord : compteurs, santé du périmètre, alertes, synchros, derniers changements, écarts, scores les plus bas |
| `GET /api/status` | états Naemon : serveurs, applications, date de relève, source, erreurs |
| `GET /api/gaps` | rapport d'écarts |
| `GET /api/changes?limit=` | historique des imports |
| `GET /api/servers/:id` | fiche serveur : attributs, applications, services Naemon, pages qui le citent, historique |
| `POST /api/simulate` `{nodeIds, includeRetired}` | panne simulée de plusieurs éléments à la fois |
| `GET /api/map?scope=perimeter\|app:<id>` | graphe à afficher (nœuds typés, zones par environnement, états) |
| `GET /api/config` | + `demo`, `naemonSource`, `version` |

`GET /api/applications` et `/api/applications/:id` gagnent `status`, `docScore`, `retired`.

### Interface

Pile : React 19, TypeScript, Vite 8, React Router 7, Tailwind 4, `@xyflow/react` 12, `elkjs`
(calcul de disposition dans un Web Worker), `lucide-react`, `cmdk` (palette Ctrl+K),
`html-to-image` (export PNG de la carte), Vitest + Testing Library. Pas de Mermaid (trop lourd
pour l'usage).

Pages :

- **Accueil** : santé du périmètre (pastilles par application), alertes en cours, applications
  à risque, fraîcheur de chaque source, derniers changements, 3 applications les moins documentées.
- **Applications** : liste avec état, criticité, environnements, score de documentation ; filtres.
- **Fiche application** : onglets Vue d'ensemble, Cartographie, Serveurs, Bases, Flux,
  Documentation (avec score détaillé), Supervision, Historique ; bouton Naemon (lien existant).
- **Serveurs** : liste filtrable (état, environnement, retirés) + **fiche serveur**.
  **Par défaut, seuls PRD et STG sont affichés** ; DEV s'ajoute d'un clic (filtre mémorisé).
  Même règle par défaut dans l'onglet Serveurs de la fiche application.
- **Cartographie** : tout le périmètre ou une application ; **PRD et STG nettement séparés**
  (deux zones distinctes, côte à côte, chacune avec sa couleur et son titre ; un serveur n'apparaît
  que dans la zone de son environnement) ; DEV masqué par défaut (une troisième zone s'ajoute
  d'un clic) ; serveurs sans environnement dans une zone « Non précisé » ; couleurs d'état, mini-carte, export PNG ; **mode simulation** : on sélectionne un ou plusieurs éléments,
  ce qui est touché s'allume, liste exportable en CSV.
- **Supervision** : alertes en cours sur le périmètre, impact réel, rapport d'écarts.
- **Historique** : changements d'un import à l'autre, filtrables par source.
- **Synchronisation** : reprise de la v1, au nouveau style, Naemon ajouté. La page Équipes de la
  v1 n'est pas reprise (aucune donnée de responsable ou d'équipe).
- Partout : recherche Ctrl+K (applications, serveurs, IP), bulle de chat, bascule FR / EN et
  clair / sombre (mémorisées dans le navigateur), rafraîchissement automatique des états toutes
  les minutes.

### Tests et contrôle

- Les tests jest de la v1 passent toujours sous Node 16.20.2 (vérifié avec nvm).
- Nouveaux tests jest : générateur démo (déterministe, cohérent), Thruk (réponses simulées),
  CSV Naemon, rapprochement, calcul des états, impact réel, historique / retraits, score, routes.
- Tests Vitest de l'interface : fonctions d'état et de format, parité des clés FR / EN.
- `npm run doctor` contrôle aussi Naemon (URL joignable, authentification, nombre d'hôtes
  rapprochés) et signale `DEMO_MODE=true` en avertissement.
- Vérification finale : clone neuf, Node 16, `npm run setup` avec une fausse v1 à côté, `npm start`,
  pages parcourues dans le navigateur en mode démo.

### Documentation

`v2/README.md` (installation, reprise de la v1), `v2/ARCHITECTURE.md` (comme la v1, à jour),
`opencode.md` complété d'une section v2 (mêmes règles : l'assistant du poste ne touche pas au code).

## Laissé au constructeur

Découpage des composants, styles exacts, structure du générateur de démo, noms internes des
modules, ordre des tâches, format exact des fichiers JSON ajoutés.

## Décisions prises sans l'utilisateur (à vérifier)

- Environnement : colonne `usedFor` (I) de l'APM, valeurs ramenées à PRD / STG / DEV
  (prd, prod, production → PRD ; stg, staging, preprod → STG ; dev, development → DEV), réglable
  dans `mappings.json` si la vraie colonne est une autre. La colonne de la marketplace prime si
  elle est remplie.
- Port 3002 pour la v2 lors de la reprise.
- `frontend/dist` versionné dans `v2/`.
- Règle des états d'application (`degraded` plutôt que `down` quand une partie seulement tombe).
- Barème du score de documentation.
- Pile de l'interface (React 19, Tailwind 4, TypeScript).
