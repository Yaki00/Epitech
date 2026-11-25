# Lyra v2 : repérage par l'IA et retour des équipes (conception)

Date : 23/11/2026. Statut : validé le 23/11/2026.
S'appuie sur : `docs/2026-11-18-v2-conception.md` (v2 livrée sur la branche `v2`) et sur le banc
d'essai privé (150 pages Confluence fictives, IA locale qwen3.8:27b), rapport du 23/11.

## Intention

Aujourd'hui, l'analyse Confluence de la v2 repose surtout sur des règles écrites dans le code :
liste des noms de serveurs connus cherchée dans le texte, expressions régulières pour les IP et
les FQDN, mots du titre pour reconnaître une page d'architecture, score de reconnaissance des
noms d'application, analyseur draw.io qui décide seul du type de lien. L'IA ne fait que compléter.

L'utilisateur veut que **l'IA fasse le repérage** (serveurs, IP, bases, applications,
responsables, nature de la page) et que **le code se contente de vérifier** ce qu'elle rend. Le
but : quand les conventions changent (autre entreprise, autres noms de serveurs, autres
documents), on adapte des **consignes en texte**, sans modifier de règle dans le code.

Il veut aussi **retrouver les équipes** de la v1 (page Équipes, responsables d'une application),
alimentées par ce que l'IA lit dans la documentation.

Le banc d'essai du 23/11 donne la ligne de départ à battre (même jeu, mêmes 150 pages) :

| Mesure | Avant |
|---|---|
| Pages classées « architecture » à tort | 13 sur 33 (précision 61 %) |
| Applications citées par un nom court ou un sigle, page rattachée | 5 sur 22 |
| Serveurs cités repérés | 92 % (noms écrits en abrégé ratés) |
| Flèches draw.io transformées en liens | 17 sur 26 |
| Liens faux dans le graphe final | 16 (surtout serveurs décommissionnés repris de vieilles pages) |
| Analyses vides quand le modèle « réfléchit » (sans relais) | 27 % |
| Responsables trouvés exploités | 0 (91 liens « responsable » extraits puis ignorés) |

## Objectifs

1. **Lecture IA d'une page** : un appel (ou un par morceau si la page est longue) rend, avec une
   citation du texte pour chaque élément : la nature de la page, sa période (actuelle, ancienne,
   cible), les applications dont elle parle, les serveurs / IP / bases / URL / files / chemins
   cités avec leur environnement et leur statut, les liens entre eux, les responsables et équipes.
2. **Vérification par le code, sans repérage** : chaque élément rendu par l'IA est gardé seulement
   si sa citation se retrouve dans la page ; chaque serveur est rapproché de l'inventaire (nom
   court, FQDN, IP) ; sinon il est « hors inventaire » ou « à valider ».
3. **Consignes modifiables** : un fichier texte de consignes pour l'IA (conventions de nommage,
   synonymes d'environnement, vocabulaire maison), lu à chaque analyse, sans toucher au code.
4. **Équipes** : responsables et équipes par application, page Équipes, carte « Responsables »
   dans la fiche application, réponse du chat à « qui s'occupe de X ».
5. **Fiabilité du modèle** : réglage pour couper la réflexion des modèles qui « réfléchissent »,
   réponses vides jamais mises en cache, nouvelle tentative avec plus de place si la réponse est
   coupée.
6. **Mesure** : relancer le banc d'essai et publier le tableau avant / après.

## Hors périmètre

- Inventaires (APM, marketplace) lus par l'IA : ils restent importés par correspondance de
  colonnes (exacte). Une IA qui propose la correspondance des colonnes d'un nouvel export est une
  évolution possible plus tard (option « C »), pas dans ce lot.
- Analyse des images, OCR, recherche par embeddings.
- Calcul d'impact, états Naemon, score de documentation : restent calculés par le code.

## À ne jamais faire (anti-objectifs)

- Laisser l'IA calculer un impact ou un état : l'impact vient du graphe, les états de Naemon.
- Garder un élément rendu par l'IA sans citation retrouvée dans la page.
- Présenter comme actif un serveur que l'IA a lu dans une page ancienne ou décrivant une cible.
- Réintroduire des règles de repérage dans le code (listes de mots, motifs de noms) : tout ce qui
  dépend des conventions va dans les consignes.
- Écrire un nom interne d'entreprise dans le dépôt (public) ; mentionner un outil d'assistance au
  code ; modifier `v1/`.
- Casser Node 16.20, ajouter un paquet au serveur.

## Approches envisagées

| | Approche | Bilan |
|---|---|---|
| **A (retenue)** | L'IA repère tout dans la page, le code vérifie (citation présente, rapprochement inventaire) ; consignes dans un fichier texte | Répond au besoin d'adaptation sans code ; l'IA est tenue par les citations et l'inventaire |
| B | Garder les règles, mais les sortir du code dans un fichier de réglages (motifs, mots-clés) | Rapide et prévisible, mais il faut toujours écrire des règles : ne répond pas au besoin |
| C | A, plus l'IA qui propose la correspondance des colonnes des inventaires | Utile si les exports changent ; reporté (hors périmètre de ce lot) |

Choix de l'utilisateur : A.

## Conception

### Ce qui change dans l'analyse d'une page

Ce qui **reste** (lecture du format, pas du repérage) :
- lecture de l'export (page HTML rendue + format de stockage), découpe en sections, tableaux mis
  à plat en texte ;
- retrait du texte barré (il signifie « obsolète » dans les pages) ;
- lecture des fichiers draw.io en boîtes et flèches (structure du fichier) ;
- import des inventaires par colonnes ;
- contrôle des pages d'architecture **par comparaison avec l'inventaire** (manquants, autre
  application, inconnus, IP différentes), mais à partir des serveurs repérés par l'IA ;
- score de documentation, impact, Naemon.

Ce qui **disparaît** comme décision du code :
- repérage des serveurs par la liste des noms connus et par motifs ;
- classement « page d'architecture » par mots du titre, tableaux, nombre d'hôtes ;
- rattachement page → application par score de reconnaissance des noms (titre, ancêtres, texte),
  et l'appel de « tri IA » séparé (fusionné dans la lecture) ;
- type de lien draw.io décidé par le type de la cible : les boîtes et flèches sont données à l'IA
  sous forme de texte (« Schéma X : boîte A → boîte B, libellé L ») et c'est elle qui qualifie ;
- devinette de l'environnement d'une page par son titre.

La reconnaissance des noms d'application (variantes, fautes, sigles) **sert encore**, mais
uniquement pour **rapprocher un nom rendu par l'IA** d'une application du périmètre, pas pour
repérer quoi que ce soit dans le texte.

### La lecture IA (un appel par page, ou par morceau)

Entrée : titre, ancêtres, espace, date de dernière modification, texte des sections (sans texte
barré), tableaux en texte, schémas draw.io en texte, liste des applications du périmètre avec
leurs variantes connues, **consignes** du fichier de consignes.

Sortie (JSON), chaque élément avec une **citation courte** du texte :
- `page` : nature parmi `architecture | exploitation | installation | incident | version |
  reunion | projet | autre`, période parmi `actuelle | ancienne | cible`, environnement principal
  éventuel ;
- `applications` : applications dont la page parle, nom de référence si reconnu, rôle
  (`sujet principal` ou `citée`) ;
- `entites` : serveurs, IP, bases, URL, files, chemins, personnes, équipes ; pour un serveur :
  environnement (PRD / STG / DEV / inconnu) et statut (`actif`, `decommissionne`, `prevu`) tel
  que la page le dit ;
- `liens` : `runs_on | uses_db | db_on | calls | reads_from | writes_to | depends_on`, sens
  « dépend de » ;
- `responsables` : personne ou équipe, application, rôle (`responsable`, `support`,
  `astreinte`, `autre`).

Une page longue est découpée en morceaux ; les morceaux d'une même page reçoivent le titre et
les applications déjà reconnues ; les résultats sont fusionnés.

### La vérification par le code

- **Citation** : chaque élément doit avoir une citation retrouvée dans le texte de la page
  (comparaison tolérante : casse, accents, espaces, ponctuation). Sinon : écarté, compté et
  listé dans un rapport.
- **Rapprochement** :
  - serveur / IP → nœud d'inventaire par `repo.resolve` (nom court, FQDN, IP) ;
  - application → nom de référence du périmètre (variantes connues) ; une application hors
    périmètre est traitée comme aujourd'hui (`ignoreOtherApplications`) ;
  - personne / équipe → nœud `team` ou `person` (nouveau type `person`), nom normalisé.
- **Serveur non trouvé dans l'inventaire** : créé avec `attrs.horsInventaire = true` ; il
  apparaît dans la fiche et dans le rapport d'écarts ; il **compte** dans l'impact s'il est dit
  actif (un cluster partagé réel peut manquer de l'inventaire du périmètre).
- **Page ancienne ou cible, serveur « décommissionné » ou « prévu »** : les liens sont gardés
  avec `attrs.periode = 'ancienne' | 'cible'` et **ne comptent pas** dans l'impact ni dans le
  graphe affiché par défaut (même traitement que les retirés : grisés, option pour les voir).
  Le chat les présente comme anciens ou prévus.
- **Pages d'architecture** : `pageKind = 'architecture'` vient de la nature rendue par l'IA ; le
  contrôle avec l'inventaire garde sa forme actuelle (`audit` : `ok`, `environment`,
  `problems[{code,n}]`, `confirmed`, `unknown`, `completeness`…) pour que l'interface, le score
  et le rapport d'écarts continuent de marcher.
- **`mentions`** (page → serveur) : un lien par serveur rapproché cité dans la page, comme
  aujourd'hui (le score de documentation s'en sert).
- **`documented_in`** : un lien par application reconnue, `attrs.role` (`sujet` ou `citee`) et
  la citation ; seules les pages où l'application est sujet principal comptent pour le score.

### Règles de confiance (IA face à l'inventaire)

L'inventaire reste la référence pour « quel serveur appartient à quelle application ». Une
citation prouve que la page le dit, pas que c'est vrai. Donc :

| L'IA dit « A tourne sur S » | Effet |
|---|---|
| S est dans l'inventaire, rattaché à A | confirme le lien existant (rien de nouveau dans l'impact) |
| S est dans l'inventaire, rattaché à une autre application B | pas de lien ajouté au graphe ; signalé comme écart « autre application » dans le contrôle de la page |
| S n'est dans aucun inventaire, et Naemon le supervise, ou une page **actuelle** modifiée depuis moins de 24 mois le dit actif | lien ajouté, S marqué « hors inventaire », compte dans l'impact |
| S n'est dans aucun inventaire et rien ne le corrobore | lien gardé « à valider » : affiché grisé, hors impact par défaut, listé dans le rapport d'écarts |
| la page est ancienne ou cible, ou S est dit décommissionné / prévu | lien gardé avec sa période, hors impact et hors graphe par défaut |

Les liens entre applications (`calls`), application → base (`uses_db`) et base → serveur
(`db_on`) n'existent pas dans les inventaires : ils viennent de la documentation. Ils comptent
dans l'impact s'ils sont lus dans une page actuelle ; ceux d'une page ancienne ou cible non.

La **période** est celle que l'IA lit dans la page (« cible », « 2019 », « obsolète »,
« historique »). La date de modification ne change pas la période ; elle sert seulement à la
corroboration d'un serveur hors inventaire (moins de 24 mois).

### Remplacement de l'analyse précédente

Quand une page est relue, tous les liens et rattachements qu'elle avait produits (règles de la
version précédente comprises : `mentions`, `documented_in`, liens IA, `pageKind`) sont
supprimés puis recréés à partir de la nouvelle lecture. Les nœuds créés seulement par d'anciennes
lectures et plus cités par aucune page sont marqués retirés (jamais supprimés), comme pour les
inventaires.

### Sans IA disponible

Plus de repérage par règles en secours : sans IA configurée, les pages sont lues et stockées
mais n'apportent ni serveurs cités, ni rattachements, ni nature ; `npm run doctor` et la page
Synchronisation le disent clairement. Si l'appel échoue pour une page, elle garde sa lecture
précédente ; au tout premier passage, elle est marquée en erreur et reprise au passage suivant.
Les tests du serveur utilisent le mécanisme `LLM_MOCK` existant (réponses préparées) ; le mode
démo n'exécute pas l'analyse (son générateur écrit directement le graphe).

### Pages à plusieurs sujets

Une page peut avoir plusieurs applications « sujet » (une page d'architecture commune, un
comité). Chaque application sujet compte la page pour son score de documentation ; une
application seulement « citée » ne la compte pas.

### Schémas draw.io

Une boîte du schéma est traitée comme un nom cité dans le texte : rapprochée de l'inventaire ou
du périmètre, sinon « à valider ». La vérification de citation porte sur le libellé de la boîte
ou de la flèche, qui doit exister dans le fichier du schéma.

### Consignes

- `backend/config/consignes-ia.md` (non versionné, propre au poste) ; modèle versionné
  `backend/config/consignes-ia.example.md`, neutre, qui explique quoi écrire : conventions de
  nommage des serveurs, sens des environnements (« recette » et « UAT » = STG…), vocabulaire
  maison, pages à ignorer.
- Le texte des consignes entre dans l'empreinte de l'analyse : modifier les consignes relance
  l'analyse des pages au prochain passage (comme un changement de périmètre aujourd'hui).
- Les mêmes synonymes d'environnement servent à l'import des inventaires : un bloc
  `environnements` facultatif dans `mappings.json` (`{"STG": ["recette", "uat"]}`) complète la
  normalisation actuelle, sans code.
- `npm run doctor` affiche si un fichier de consignes est présent et sa taille.

### Fiabilité des appels IA

- `LLM_REASONING_EFFORT` (vide par défaut = rien envoyé ; ex. `none`) : ajouté aux requêtes
  pour couper ou limiter la réflexion des modèles qui en ont une.
- `LLM_MAX_TOKENS_EXTRACT` (défaut 4096) pour la lecture.
- Réponse vide, coupée (`finish_reason = length`) ou JSON illisible : jamais mise en cache ; une
  nouvelle tentative avec le double de place ; puis erreur comptée pour la page (la page garde
  son analyse précédente si elle en avait une).
- `npm run doctor` envoie une petite lecture d'essai et signale une réponse vide ou coupée, avec
  le conseil de régler `LLM_REASONING_EFFORT`.

### Équipes

- Sources : `responsables` rendus par l'IA (liens `owned_by` application → personne / équipe,
  `attrs.role`, citation, page) et, si l'APM les fournit, les colonnes responsable / équipe
  (bloc `attrs` du mapping, comme en v1).
- API : `GET /api/teams` (reprise de la v1, élargie) : équipes et personnes, leurs applications,
  rôle, pages sources ; `applications/:id` gagne `owners[]`.
- Interface : page **Équipes** dans la barre latérale ; carte **Responsables** dans la vue
  d'ensemble de la fiche application (avec le lien vers la page source) ; recherche Ctrl+K sur
  les personnes et équipes ; chat : outil qui répond « qui s'occupe de X ».
- Une personne citée dans une page ancienne est montrée comme ancienne.
- Seuls le nom, le rôle, l'application et la page source sont gardés : ni adresse électronique ni
  téléphone (l'IA est consignée de ne pas les rendre, le code les écarte s'ils apparaissent).
- Si l'APM et la documentation donnent des responsables différents, les deux sont montrés avec
  leur source.

### Effet sur l'installation au travail

Changer la façon d'analyser change les demandes envoyées à l'IA : **au premier passage après la
mise à jour, toutes les pages sont relues par l'IA** (le cache de la v1 ne sert plus pour la
lecture ; il sert encore pour les résumés tant que leurs entrées ne changent pas). Sur le banc :
environ 26 minutes pour 150 pages avec l'IA du PC fixe. La reprise de la v1 (`npm run setup`)
reste valable ; le README le dit.

### Mode démo

Le jeu de démo gagne des responsables et équipes fictifs et des liens « ancienne » / « cible »
pour que les nouvelles cartes s'affichent ; le chat simulé répond à « qui s'occupe de X ».

### Banc d'essai (privé, hors dépôt)

- La vérité du banc gagne les responsables et équipes (par application et par page) et le statut
  des serveurs cités dans chaque page.
- La notation ajoute : responsables trouvés, liens écartés faute de citation, liens « ancienne /
  cible » correctement mis à part, et un tableau avant / après.
- Deux passages : avec `LLM_REASONING_EFFORT=none` réglé dans Lyra **sans le relais** du banc,
  puis sans réglage pour mesurer le repli automatique.

Le générateur du banc est complété pour que les pages contiennent réellement des responsables
et des statuts de serveurs, et la vérité les enregistre. Les objectifs ne bloquent pas la
livraison : ils sont mesurés et rapportés ; un objectif manqué donne une liste précise des
erreurs à corriger (consignes ou code) avant de passer au travail.

Objectifs chiffrés (indicatifs, à confirmer par la mesure) : pages d'architecture précision
≥ 90 % ; rattachement sur nom court ou sigle ≥ 80 % ; serveurs cités ≥ 97 % ; flèches draw.io
≥ 90 % ; liens faux dans le graphe ≤ 5 ; responsables trouvés ≥ 90 % ; zéro analyse vide.

## Laissé au constructeur

Découpage en modules, texte exact des consignes système, taille des morceaux, format exact du
JSON intermédiaire, tolérance de la comparaison des citations, organisation des tests, ordre des
tâches, détail visuel de la page Équipes (dans le style de la v2).

## Décisions prises sans l'utilisateur (à vérifier)

- Inventaires laissés en lecture par colonnes (exacte) ; l'IA ne les lit pas.
- Un serveur hors inventaire dit actif compte dans l'impact ; ancien ou prévu, non.
- Fichier de consignes en texte libre plutôt qu'en réglages structurés.
- Au premier passage après la mise à jour, toutes les pages sont relues par l'IA.
- Nouveau type de nœud `person` à côté de `team`.
- Règles de confiance du tableau ci-dessus (inventaire de référence ; hors inventaire compté
  seulement si Naemon le supervise ou si une page actuelle de moins de 24 mois le dit actif).
- Pas de repérage par règles en secours quand l'IA manque.
- Taille des morceaux et `LLM_MAX_TOKENS_EXTRACT` réglables, valeurs par défaut prudentes
  (contexte de 32 000 jetons supposé), le modèle du travail n'étant pas connu en détail.
