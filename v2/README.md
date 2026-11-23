# Lyra v2 (Infrastructure Intelligence)

Graphe de dépendances applications, serveurs et bases, construit depuis l'export Confluence, la marketplace, l'APM
et Naemon, pour répondre à « si je touche X, qu'est-ce qui est impacté ? ». La v2 reprend le moteur de la v1 et ajoute
une interface refaite, la supervision Naemon en direct, l'historique des changements, les éléments retirés et un score
de documentation.

Architecture, conventions et contrat d'API : voir **[ARCHITECTURE.md](ARCHITECTURE.md)**.

## Prérequis

- **Node 16.20** (testé pour 16.20.2) pour le serveur, Windows ou Linux. Pas de base de données : le graphe est stocké en fichiers JSON.
- L'**interface** (React 19, TypeScript, Vite 8) se compile sur une machine **Node >= 22.12**. Le résultat, `frontend/dist`, est **versionné** dans le dépôt :
  le poste Node 16 n'a donc rien à compiler, le serveur sert l'interface et l'API sur le même port (3002).

## Démarrage rapide (démo)

```bash
npm run setup      # installe le backend, crée backend/.env (DEMO_MODE=true) et les fichiers de config
npm start          # http://localhost:3002 : jeu de données fictif, aucun appel réseau
```

Le mode démo génère au démarrage un parc inventé (applications, serveurs, bases, supervision simulée, historique, assistant
de démonstration). Il écrit dans `backend/data/demo-store`, jamais dans `DATA_DIR`.
Pour passer aux vraies données : `DEMO_MODE=false` dans `backend/.env`.

## Installation sur un poste avec la v1 (reprise automatique)

La v2 se range à côté de la v1 : `.../v1` et `.../v2` dans le même dépôt. La v1 n'est jamais modifiée.

```bash
cd v2
npm run setup
```

Si `../v1/backend/.env` existe et que `v2/backend/.env` n'existe pas encore, `npm run setup` reprend la v1, étape par étape :

1. **Config** : `perimeter.json` et `mappings.json` sont copiés de la v1 (sans écraser un fichier déjà présent).
2. **Cache IA** : le dossier `LLM_CACHE_DIR` de la v1 est copié (les pages déjà analysées ne repartent pas à l'IA).
3. **Store** : le dossier `DATA_DIR` de la v1 est copié (le graphe est disponible tout de suite).
4. **Inventaires** : `data/raw/apm` et `data/raw/marketplace` sont copiés.
5. **`.env`** : celui de la v1 est copié, puis un bloc « Lyra v2 » est ajouté avec `PORT=3002`, `DEMO_MODE=false`,
   `CONFLUENCE_FETCH=false` et `CONFLUENCE_EXPORT_DIR` pointant vers l'export de la v1. Les lignes actives de la v1 pour ces
   clés sont mises en commentaire dans la copie (la première occurrence d'une clé l'emporte).
6. Les chemins absolus de la v1 (`DATA_DIR`, `LLM_CACHE_DIR`) sont ramenés aux dossiers de la v2.

Relancer `npm run setup` n'écrase rien et n'ajoute pas deux fois le bloc v2. La v1 reste seule à récupérer Confluence :
la v2 lit son export sans jamais le modifier (`CONFLUENCE_FETCH=false`). Pour que la v2 récupère elle-même Confluence,
mettre `CONFLUENCE_FETCH=true` et décider qui, de la v1 ou de la v2, garde la récupération.

### Faire tourner la v1 et la v2 côte à côte

| Version | Port | Données |
|---|---|---|
| v1 | 3001 | `v1/backend/data` |
| v2 | 3002 | `v2/backend/data` (copie faite par `npm run setup`) |

Chacune a son store : les synchros de l'une n'affectent pas l'autre.

## Installation sans v1

```bash
cd v2
npm run setup      # npm install du backend + backend/.env, config/mappings.json et config/perimeter.json depuis les modèles
# 1. backend/.env : DEMO_MODE=false puis IA (LLM_*), Confluence (URL, jeton, espaces), chemins
#    clés des espaces Confluence : node backend/scripts/fetch-confluence.js --list-spaces
# 2. backend/config/perimeter.json : les applications suivies (noms de la colonne A de l'APM)
# 3. backend/config/mappings.json : fichiers CSV et colonnes (nom exact ou lettre Excel, ex. "CK")
#    export APM : déposer le CSV dans backend/data/raw/apm/ (le plus récent est pris)
npm run doctor     # vérifie IA, Confluence, Naemon, fichiers ; rapport à copier-coller
npm test           # tests du backend (jest), sans IA ni réseau
npm run sync:all   # récupère Confluence, importe les CSV, analyse avec l'IA (seulement ce qui a changé)
npm start          # http://localhost:3002
```

Premier passage : tester sur 20 pages avant de tout lancer :
`node backend/scripts/fetch-confluence.js --limit 20` puis `node backend/scripts/sync-confluence.js --llm --limit 20`.
Rapports (Excel) dans `backend/data/rapports/`.

### Lancement automatique sur un poste Windows (Planificateur de tâches)

Dans une invite de commandes, en adaptant le chemin (ici tous les jours à 7 h ; `/SC HOURLY` pour toutes les heures) :

```bat
mkdir C:\chemin\vers\v2\logs
schtasks /Create /TN "Lyra v2 sync" /SC DAILY /ST 07:00 /TR "cmd /c cd /d C:\chemin\vers\v2 && npm run sync:all >> logs\sync.log 2>&1"
schtasks /Run /TN "Lyra v2 sync"      &REM pour tester tout de suite
schtasks /Delete /TN "Lyra v2 sync"   &REM pour l'enlever
```

La tâche tourne quand la session est ouverte. Chaque étape ne refait que ce qui a changé ; le journal est dans `logs\sync.log`.
La supervision Naemon n'a pas besoin de tâche planifiée : le serveur relève l'état lui-même toutes les `NAEMON_POLL_MINUTES`.

## Configurer Naemon

Facultatif. `NAEMON_SOURCE` choisit la source de l'état en direct : `off` (défaut), `thruk` (API REST) ou `csv` (export Thruk).
Sans source, l'interface affiche « inconnu » (jamais un faux « tout va bien »).

**Thruk (API REST)**, dans `backend/.env` :

```
NAEMON_SOURCE=thruk
NAEMON_THRUK_URL=https://<naemon>/thruk
NAEMON_TOKEN=<jeton Thruk>            # envoyé en en-tête X-Thruk-Auth-Key
# ou NAEMON_USER et NAEMON_PASSWORD   # authentification Basic (laisser NAEMON_TOKEN vide)
NAEMON_POLL_MINUTES=5
```

Lecture seule : deux GET (hôtes et services). Un jeton refusé, une page HTML de connexion ou un Thruk injoignable
conservent l'état précédent et l'erreur est visible dans `/api/status` et la page Supervision.

**Export CSV** (si l'API n'est pas accessible) : déposer l'export Thruk, décrire les colonnes dans le bloc `naemon` de
`backend/config/mappings.json` (exemple dans `mappings.example.json`), puis :

```
NAEMON_SOURCE=csv
NAEMON_CSV_FILE=./data/raw/naemon/hosts_*.csv     # un motif * est accepté, le plus récent est pris
```

Le rapprochement entre hôtes Naemon et serveurs du graphe se fait par nom court, FQDN ou IP. Un hostgroup peut être rattaché
à une application avec `naemonHostgroups` dans `perimeter.json`. `NAEMON_URL_TEMPLATE` règle le lien du bouton
« Monitoring Naemon » (`{app}` est remplacé par le nom de l'application).

Certificat d'entreprise : si `npm run doctor` signale `unable to get local issuer certificate`, définir la variable
d'environnement **système** `NODE_EXTRA_CA_CERTS=<chemin du certificat racine .pem>` (pas dans `.env`), puis relancer.

## Historique, éléments retirés et score de documentation

- **Historique** : à chaque import d'inventaire (APM, marketplace), Lyra compare avec le précédent et note ce qui a été ajouté,
  retiré ou modifié (page Historique, `/api/changes`). Les `HISTORY_KEEP` dernières entrées sont gardées (50 par défaut).
- **Retirés** : un serveur ou un lien qui disparaît d'un import **complet** est marqué « retiré », jamais supprimé. Il
  disparaît des compteurs et de la carte (case « Afficher les retirés » pour le voir) et revient tout seul s'il réapparaît.
  Un import vide ou incomplet ne retire rien.
- **Score de documentation** (sur 100, calculé à la volée) : page d'architecture liée (35), aucun écart avec les inventaires
  (25), part des serveurs cités par une page liée (30), résumé IA disponible (10).

## Interface (frontend/)

```bash
cd frontend       # sur une machine Node >= 22.12
npm install
npm run build     # produit frontend/dist, à committer
npm run dev       # développement : http://localhost:5173 (le backend doit tourner sur :3002)
npm test          # vitest
```

Pages : Accueil, Applications (fiche à onglets), Serveurs (fiche serveur), Cartographie (zones PRD, STG, DEV, Non précisé,
simulation de panne), Supervision, Historique, Synchronisation, bulle de l'assistant sur toutes les pages.
Environnements : `PRD`, `STG`, `DEV`, plus « Non précisé » pour un serveur sans environnement connu.

## Alimenter le graphe

```bash
cd backend
npm run fetch:confluence                  # pages nouvelles ou modifiées des espaces CONFLUENCE_SPACES
npm run fetch:inventory                   # télécharge la marketplace (MARKETPLACE_URL) si pas encore fait aujourd'hui
node scripts/fetch-inventory.js --force   # retélécharge même si déjà vérifié aujourd'hui
node scripts/fetch-confluence.js --full   # retélécharge tout (ex. une fois par semaine)
node scripts/summarize-apps.js            # résumé IA des applications (après sync-confluence --llm)
npm run sync:inventory                    # toutes les sources CSV de mappings.json (historique et retraits inclus)
node scripts/sync-inventory.js apm        # une seule
npm run sync:confluence                   # sans IA : structure, tableaux, liens, draw.io, mentions
node scripts/sync-confluence.js --llm --limit 20   # test de l'extraction IA sur 20 pages
npm run sync:confluence:llm               # tout, avec IA (incrémental)
```

Les synchros peuvent tourner pendant que le serveur est lancé : il recharge les données tout seul. Elles se lancent aussi depuis
la page Synchronisation (désactivable avec `ALLOW_UI_SYNC=false`, inactives en mode démo).

## Format attendu de l'export Confluence

Identique à la v1 : un dossier par page sous `CONFLUENCE_EXPORT_DIR`, avec `metadata.json` (pageId obligatoire) et `page.html`
(rendu), plus `page.storage.xml`, `images/` et `attachments/` facultatifs. Le texte barré est considéré comme obsolète.

## Exemples

```bash
curl "localhost:3002/api/overview"
curl "localhost:3002/api/status"
curl "localhost:3002/api/gaps?format=csv" -o ecarts-naemon.csv
curl -X POST localhost:3002/api/simulate -H "Content-Type: application/json" -d "{\"nodeIds\":[\"server:srvalto01\"]}"
curl -X POST localhost:3002/api/ask -H "Content-Type: application/json" -d "{\"question\":\"Que se passe-t-il si srvalto01 redémarre ?\"}"
```
