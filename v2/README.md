# Lyra v2 (Infrastructure Intelligence)

Graphe de dépendances applications, serveurs et bases, construit depuis l'export Confluence, la marketplace, l'APM
et Naemon, pour répondre à « si je touche X, qu'est-ce qui est impacté ? ». La v2 reprend le moteur de la v1 et ajoute
une interface refaite, la supervision Naemon en direct, l'historique des changements, les éléments retirés, un score
de documentation, et surtout un **repérage fait par l'IA** : elle lit chaque page Confluence (serveurs, bases, liens,
responsables, nature et période de la page) et le code ne fait que vérifier ce qu'elle rend.

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
4. **Inventaires** : `data/raw/apm` et `data/raw/marketplace` sont copiés une seule fois, à la reprise. Un nouvel export APM ou marketplace déposé
   ensuite dans `v1/backend/data/raw/` n'est pas vu par la v2 : le déposer dans `v2/backend/data/raw/apm` (ou `marketplace`), ou faire pointer
   `mappings.json` de la v2 vers le dossier de la v1.
5. **`.env`** : celui de la v1 est copié, puis un bloc « Lyra v2 » est ajouté avec `PORT=3002`, `DEMO_MODE=false`,
   `CONFLUENCE_FETCH=false` et `CONFLUENCE_EXPORT_DIR` pointant vers l'export de la v1. Les lignes actives de la v1 pour ces
   clés sont mises en commentaire dans la copie (dotenv garde la dernière occurrence d'une clé, donc le bloc v2, placé à la fin, l'emporte).
6. Les chemins absolus de la v1 (`DATA_DIR`, `LLM_CACHE_DIR`) sont ramenés aux dossiers de la v2.

**Au premier passage après la mise à jour, toutes les pages sont relues par l'IA** : la façon d'analyser a changé, donc les demandes
envoyées au modèle aussi, et le cache de la v1 ne sert plus pour la lecture (il sert encore pour les résumés tant que leurs entrées
ne changent pas). Prévoir un passage long (de l'ordre d'une demi-heure pour 150 pages avec une IA locale). Les passages suivants ne
relisent que les pages modifiées, ou toutes si les consignes ou le périmètre changent.

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
# 4. facultatif : backend/config/consignes-ia.md, consignes de lecture pour l'IA, à écrire à partir du modèle (voir plus bas)
#    export APM : déposer le CSV dans backend/data/raw/apm/ (le plus récent est pris)
npm run doctor     # vérifie IA, Confluence, Naemon, fichiers ; rapport à copier-coller
npm test           # tests du backend (jest), sans IA ni réseau
npm run sync:all   # récupère Confluence, importe les CSV, lit les pages avec l'IA (seulement ce qui a changé)
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

## Lecture des pages par l'IA et consignes

L'analyse Confluence ne contient aucune règle de repérage (pas de liste de noms de serveurs, pas de motif de nom, pas de mot-clé de
titre). Pour chaque page, l'IA rend en JSON la nature de la page, sa période (actuelle, ancienne, cible), les applications dont elle
parle, les serveurs, bases, files, URL cités avec leur environnement et leur statut, les liens entre eux et les responsables, chaque
élément avec une **citation** du texte. Le code garde un élément seulement si sa citation se retrouve dans la page, puis rapproche les
serveurs de l'inventaire (nom court, FQDN ou IP). Une page longue est lue en plusieurs morceaux (`READING_CHUNK_CHARS`, 12000 caractères
par défaut). L'IA ne calcule jamais un impact ni un état : cela reste le travail du graphe et de Naemon.

### Le fichier de consignes

Tout ce qui dépend des conventions de l'entreprise (noms de serveurs, sens des environnements, vocabulaire, pages à ignorer) s'écrit en
texte libre dans `backend/config/consignes-ia.md`, sans toucher au code. `npm run setup` ne le crée pas : on l'écrit à partir du
modèle `backend/config/consignes-ia.example.md` (4 rubriques, exemples fictifs à remplacer, jamais à garder tels quels : `npm run doctor`
signale une copie non adaptée du modèle). Le fichier n'est pas versionné et se règle avec `CONSIGNES_FILE` dans `.env`.

- Phrases simples, une règle par ligne. Au-delà de 8 000 caractères, la fin est ignorée (`npm run doctor` le signale).
- Fichier absent ou vide : l'analyse marche quand même, avec les seules règles générales.
- Modifier les consignes relance la lecture de **toutes** les pages au prochain passage (elles entrent dans l'empreinte de l'analyse).
- Les consignes ne contiennent ni mot de passe ni donnée personnelle : le texte part à l'IA avec chaque page.

### Synonymes d'environnement

Les environnements sont `PRD`, `STG` et `DEV` (sinon « Non précisé »). Pour l'import des inventaires, des synonymes se déclarent dans
le bloc facultatif `environnements` de `backend/config/mappings.json` :

```json
"environnements": { "STG": ["recette", "uat"], "DEV": ["integration"], "PRD": ["exploitation"] }
```

Les mêmes mots se disent à l'IA dans la rubrique « Environnements » des consignes (l'IA ne rend que `PRD`, `STG`, `DEV` ou rien).
Ce bloc sert aussi au contrôle de l'environnement d'une page : il n'est retenu que si le titre ou les pages parentes le disent, avec un
mot qui le désigne (`PRD`, `production`, `préproduction`... ou un mot du bloc). Un mot maison absent du bloc (« recette ») fait écarter
l'environnement.

### Réglages du modèle

| Variable | Rôle |
|---|---|
| `LLM_REASONING_EFFORT` | vide par défaut (rien n'est envoyé). Mettre `none` si le modèle « réfléchit » et rend des réponses vides ou coupées |
| `LLM_MAX_TOKENS_EXTRACT` | place de réponse pour la lecture d'un morceau (4096 par défaut) |
| `READING_CHUNK_CHARS` | taille d'un morceau de page (12000 par défaut, 1000 au minimum) |
| `CONSIGNES_FILE` | chemin du fichier de consignes (`./config/consignes-ia.md` par défaut) |

Une réponse vide, coupée ou en JSON illisible n'est jamais gardée en cache : une nouvelle tentative a lieu avec le double de place, puis la page
passe en erreur et garde sa lecture précédente. Elle est reprise au passage suivant. `npm run doctor` envoie une petite lecture d'essai et
conseille `LLM_REASONING_EFFORT=none` quand la réponse est vide ou coupée.

### Ce que la vérification décide

L'inventaire (APM, marketplace) reste la référence pour « quel serveur appartient à quelle application ».

| L'IA lit « A tourne sur S » | Effet |
|---|---|
| S est dans l'inventaire, rattaché à A | confirme le lien existant, rien de nouveau |
| S est dans l'inventaire, rattaché à une autre application | aucun lien ajouté, écart « autre application » signalé |
| S est hors inventaire, supervisé par Naemon ou cité actif par une page actuelle modifiée depuis moins de 24 mois | lien ajouté, S marqué « Hors inventaire », compté dans l'impact |
| S est hors inventaire et rien ne le corrobore | lien « À valider » : grisé, hors impact par défaut, listé dans le rapport d'écarts |
| la page est ancienne ou décrit une cible, ou S est dit décommissionné ou prévu | lien gardé avec sa période (« Ancien », « Cible »), hors impact et hors carte par défaut |

Les liens entre applications, vers les bases et entre bases et serveurs n'existent pas dans les inventaires : ils viennent des pages
actuelles. Dans l'interface, la case « Afficher retirés, anciens et à valider » les rend visibles.

### Sans IA

Sans IA configurée, ou sans `--llm` en ligne de commande, il n'y a plus de repérage de secours : les pages sont stockées mais n'apportent ni serveurs cités, ni
rattachement, ni nature de page. La synchronisation le dit dans son journal et `npm run doctor` aussi. Si l'appel échoue pour une page, elle
garde sa lecture précédente. L'import des inventaires, l'impact, Naemon et le score de documentation ne dépendent pas de l'IA.

### Rapports

Dans `backend/data/rapports/` (CSV, ouverts avec Excel) : `perimetre-pages.csv` (pages par application, avec la citation et la forme écrite),
`perimetre-orthographes.csv` (formes écrites rapprochées d'une application, hors nom et alias déclarés), `lectures-rejets.csv` (éléments
écartés par la vérification : citation introuvable, application inconnue ou hors périmètre) et `architecture-*.csv` (contrôle des pages
d'architecture contre l'inventaire).

## Équipes et responsables

Les responsables viennent de ce que l'IA lit dans les pages (personne ou équipe, application, rôle : responsable, support, astreinte,
autre, période actuelle ou ancienne) et, si les colonnes sont décrites dans la relation APM de `mappings.json` (`owner`, `supportTeam`,
voir `mappings.example.json`), de l'APM. Si les deux divergent, les deux sont montrés avec leur source. Seuls le nom, le rôle,
l'application et la page source sont gardés : ni adresse électronique ni téléphone (l'IA est consignée de ne pas les rendre, le code
les retire s'ils apparaissent).

- Page **Équipes** : une carte par personne ou équipe avec ses applications (filtre `?q=`, recherche Ctrl+K), « Non renseignée » en dernier.
- Fiche application : carte **Responsables** avec les pages sources.
- API : `GET /api/teams` et `owners[]` dans `GET /api/applications/:id`.
- Assistant : « Qui s'occupe de X ? » (outil `owners_of`).

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
simulation de panne), Équipes, Supervision, Historique, Synchronisation, bulle de l'assistant sur toutes les pages.
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
npm run sync:confluence                   # sans IA : pages stockées, rien n'est déduit (voir « Sans IA »)
node scripts/sync-confluence.js --llm --limit 20   # test de la lecture IA sur 20 pages
npm run sync:confluence:llm               # tout, avec IA (incrémental)
node scripts/sync-confluence.js --llm --force      # relit toutes les pages, même inchangées
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
