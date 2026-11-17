# Lyra v1 (Infrastructure Intelligence)

Graphe de dépendances applications ↔ serveurs ↔ bases, construit depuis l'export Confluence, la marketplace,
l'APM et Naemon, pour répondre à « si je touche X, qu'est-ce qui est impacté ? ».

Architecture, conventions et feuille de route : voir **[ARCHITECTURE.md](ARCHITECTURE.md)**.

## Prérequis

- **Node 16.20** (testé pour 16.20.2), Windows ou Linux. Pas de base de données à installer : le graphe est stocké en fichiers JSON.
- Le **frontend** (Vite 6) se compile sur une machine **Node ≥ 20**, puis on copie `frontend/dist` à côté du backend.
  Le backend sert alors l'interface et l'API sur le même port.

## Démarrage (poste Node 16)

```bash
npm run setup      # npm install du backend + crée backend/.env, config/mappings.json et config/perimeter.json depuis les modèles
# 1. backend/.env : tout est commenté (IA, Confluence : URL, jeton, espaces ; chemins)
#    clés des espaces Confluence : node backend/scripts/fetch-confluence.js --list-spaces
# 2. backend/config/perimeter.json : les applications suivies (noms de la colonne A de l'APM)
# 3. backend/config/mappings.json : fichiers CSV et colonnes (nom exact ou lettre Excel, ex. "CK")
#    export APM : déposer le CSV dans backend/data/raw/apm/ (le plus récent est pris)
npm run doctor     # vérifie IA, Confluence, fichiers ; rapport à copier-coller
npm test           # tests du backend (jest), sans IA ni réseau
npm run sync:all   # récupère Confluence, importe les CSV, analyse avec l'IA (seulement ce qui a changé)
npm start          # http://localhost:3001 (interface si frontend/dist est présent, sinon API seule)
```

Premier passage : tester sur 20 pages avant de tout lancer :
`node backend/scripts/fetch-confluence.js --limit 20` puis `node backend/scripts/sync-confluence.js --llm --limit 20`.
Rapports (Excel) dans `backend/data/rapports/`.

### Lancement automatique sur un poste Windows (Planificateur de tâches)

Dans une invite de commandes, en adaptant le chemin (ici tous les jours à 7 h ; `/SC HOURLY` pour toutes les heures) :

```bat
mkdir C:\chemin\vers\v1\logs
schtasks /Create /TN "Lyra sync" /SC DAILY /ST 07:00 /TR "cmd /c cd /d C:\chemin\vers\v1 && npm run sync:all >> logs\sync.log 2>&1"
schtasks /Run /TN "Lyra sync"      &REM pour tester tout de suite
schtasks /Delete /TN "Lyra sync"   &REM pour l'enlever
```

La tâche tourne quand la session est ouverte. Chaque étape ne refait que ce qui a changé ; le journal est dans `logs\sync.log`.
Sur un serveur Linux, l'équivalent est un timer systemd (à venir).

Si un `package-lock.json` d'une ancienne version traîne dans `backend/`, supprimez-le avec `backend/node_modules` avant `npm run setup`.

## Frontend (machine Node ≥ 20)

```bash
cd frontend
npm install
npm run build      # produit frontend/dist : à copier dans frontend/ sur le poste Node 16
npm run dev        # développement : http://localhost:3000 (le backend doit tourner sur :3001)
npm test           # vitest
```

## Alimenter le graphe

```bash
cd backend
npm run fetch:confluence                  # récupère les pages nouvelles ou modifiées des espaces CONFLUENCE_SPACES
npm run fetch:inventory                   # télécharge la marketplace (MARKETPLACE_URL) si pas encore fait aujourd'hui
node scripts/fetch-inventory.js --force   # retélécharge même si déjà vérifié aujourd'hui
node scripts/fetch-confluence.js --full   # retélécharge tout (ex. une fois par semaine)
node scripts/summarize-apps.js            # résumé IA des applications (après sync-confluence --llm)
npm run sync:inventory                    # toutes les sources CSV de mappings.json
node scripts/sync-inventory.js apm        # une seule
npm run sync:confluence                   # sans IA : structure, tableaux, liens, draw.io, mentions
node scripts/sync-confluence.js --llm --limit 20   # test de l'extraction IA sur 20 pages
npm run sync:confluence:llm               # tout, avec IA (incrémental : seules les pages modifiées)
```

Les synchros peuvent tourner pendant que le serveur est lancé : il recharge les données tout seul.
Elles se lancent aussi depuis la page Synchronisation de l'interface (boutons Confluence, APM, Marketplace, Tout relancer).

## Format attendu de l'export Confluence

Un dossier par page, à n'importe quelle profondeur sous `CONFLUENCE_EXPORT_DIR` (par exemple un sous-dossier par espace) :

```
0006 - Paris Service Delivery/
  metadata.json       obligatoire : pageId ; utiles : title, url, spaceKey, version, updatedAt, parentId, ancestors, labels
  page.html           obligatoire : HTML rendu de la page (sans nettoyage)
  page.storage.xml    optionnel : format storage (paramètres des macros : nom des diagrammes draw.io, Jira…)
  images/             optionnel
  attachments/        optionnel : pièces jointes, dont les diagrammes <nom>.drawio
```

- La clé d'une page est `pageId` ; le nom du dossier n'est pas utilisé comme identifiant.
- Le texte barré est considéré comme obsolète et ignoré.
- `entities` et `keywords` de `metadata.json` sont ignorés : Lyra recalcule les entités.
- L'ancien format (`pages/*.json` au format API REST + `attachments/<pageId>/`) reste accepté.

## Exemples

```bash
curl "localhost:3001/api/search?q=10.20.30.41"
curl "localhost:3001/api/impact/server:srvalto01"
curl -X POST localhost:3001/api/ask -H "Content-Type: application/json" -d "{\"question\":\"Que se passe-t-il si srvalto01 redémarre ?\"}"
```
