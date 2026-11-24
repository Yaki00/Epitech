# Lyra v2 : assistant opérationnel sur la documentation (conception)

Date : 24/11/2026. Statut : validé le 24/11/2026 (7 questions du relecteur tranchées, marquées « choix du constructeur »).
S'appuie sur : `docs/2026-11-23-v2-reperage-ia-conception.md` (lecture IA des pages, vérification par citation) et sur
le banc d'essai privé (pages Confluence fictives, IA locale qwen3.8:27b, passage du 24/11 : 0 lien faux dans l'impact,
période juste sur 149 pages sur 150).

## Intention

Lyra sait aujourd'hui dire ce qui dépend de quoi, ce qui tombe si un serveur s'arrête et qui s'occupe d'une
application. Elle ne sait pas aider à résoudre un problème : les pages Confluence sont lues par l'IA, mais seuls les
serveurs, les liens et les responsables en sont gardés. Le contenu des post-mortems (cause, solution), des notes de
version (corrections), des procédures (étapes) et des pages de bonnes pratiques est perdu.

L'utilisateur veut un assistant **vraiment opérationnel** : quand il y a un souci, ou qu'une question se pose sur une
procédure, Lyra retrouve ce que la documentation dit déjà et donne **la solution avec le lien** vers la page. Exemples :

- « Q.MRL.EVT est pleine, Marelle ne publie plus » : l'incident de mars sur le même bus, sa cause, ce qui a été fait,
  les tickets, et la procédure de purge de la file.
- « Plantage à l'ouverture d'un dossier sans ayant droit sur ONP » : corrigé en 7.3 (note de version, date de mise en
  production).
- « Comment on relance Ondine Paiements ? » : le runbook, l'ordre d'arrêt et de relance, les dépendances à vérifier.
- « Procédure de rotation de certificat pour Brocéliande ? » : s'il n'y en a pas, la plus proche (celle d'une autre
  application sur le même socle), présentée comme telle.
- Une question sans réponse dans la documentation : Lyra le dit, sans inventer.

Le premier usage est le chat (la personne tape sa question ou colle son message d'erreur). Partir d'une alerte Naemon
viendra ensuite, sur la même base (voir « Suite prévue »).

## Objectifs

1. **Fiches** : à la synchro, chaque page opérationnelle donne une ou plusieurs fiches courtes et normalisées
   (incident, correctif, procédure, bonne pratique), chaque champ prouvé par une citation de la page, avec le lien vers
   la page et la section.
2. **Fiches dans le graphe** : reliées aux applications et serveurs qu'elles concernent, et entre elles quand la page le
   dit (une correction qui cite un incident ou un ticket).
3. **Recherche** : trouver les fiches qui répondent à une question ou ressemblent à un problème, en tenant compte des
   applications citées dans la question et de leurs voisines dans le graphe, sans modèle d'embeddings.
4. **Assistant** : deux outils de plus pour le chat existant (chercher, ouvrir une fiche), des réponses qui citent leurs
   sources, et un contrôle par le code : un lien qui ne vient pas des résultats est retiré ; rien de trouvé, Lyra le dit.
5. **Interface** : sources cliquables sous la réponse du chat ; fiches de l'application dans sa page.
6. **Mesure** : le banc d'essai reçoit des pages de ce genre et une liste de questions avec la réponse attendue.

## Hors périmètre

- Partir d'une alerte Naemon ou d'un ticket (suite prévue, pas dans ce lot).
- Écrire dans Confluence, créer ou modifier des tickets, lancer une commande ou une procédure : Lyra montre, n'agit pas.
- Embeddings et base vectorielle (aucun modèle d'embeddings n'est listé sur la passerelle ; voir « Recherche »).
- Analyse des images et des captures d'écran des pages.
- Pages hors des espaces récupérés (`CONFLUENCE_SPACES`).

## À ne jamais faire (anti-objectifs)

- **Inventer** une solution, une commande, un numéro de ticket, une version ou un lien. Un lien donné dans une réponse
  vient toujours d'une fiche ou d'une page trouvée par les outils.
- **Présenter une procédure ancienne comme actuelle** : une fiche d'une page ancienne (période `past`) ou remplacée est
  toujours signalée comme telle, et passe après une fiche actuelle équivalente.
- **Présenter une procédure d'une autre application comme celle demandée** : « la plus proche » est dite comme telle.
- Recopier un mot de passe, un jeton ou une adresse électronique d'une page dans une fiche ou une réponse.
- Ralentir ou fragiliser la synchro actuelle : une fiche en échec ne fait jamais échouer la lecture de la page.

## Contraintes

- Node 16 au travail (Windows et Linux), aucune dépendance native nouvelle ; la recherche est écrite dans le projet.
- IA : passerelle compatible OpenAI, modèle `qwen3.8-27b` (celui mesuré sur le banc) ; elle peut refuser le réglage de
  réflexion, Lyra s'en accommode déjà (appels plus lents).
- Tout passe par la copie locale des pages (`CONFLUENCE_EXPORT_DIR`), jamais par Confluence pendant l'analyse ou une
  question.
- Dépôt public : aucun nom interne d'entreprise, d'outil ou de personne réelle dans le code, les tests ou la
  documentation.
- Textes de l'interface en français et en anglais (`t()`), comme le reste.
- Volume au travail : de l'ordre de quelques milliers de pages ; l'index tient en mémoire.

## Approches étudiées

1. **RAG classique** : découper les pages, chercher les morceaux proches de la question, faire répondre l'IA dessus.
   Rapide à écrire, mais « proche » reste approximatif (une procédure de 2019 remonte comme celle d'aujourd'hui), aucun
   lien entre un incident, son application et son correctif, rien ne garantit le lien donné, et il faut un modèle
   d'embeddings que la passerelle ne propose pas.
2. **Agent libre** : l'IA fouille la copie locale à chaque question (lister, ouvrir, chercher). Rien à préparer, mais
   avec un modèle de 27 milliards de paramètres c'est lent, imprévisible et difficile à mesurer.
3. **Fiches dans le graphe, recherche, assistant encadré** (retenue par l'utilisateur le 24/11) : l'IA prépare des
   fiches vérifiées à la synchro, la recherche porte sur ces fiches (et sur les sections des pages en second recours),
   l'assistant suit un nombre d'étapes borné et le code contrôle ses liens. Plus de travail à la synchro, mais des
   réponses fiables, traçables et mesurables, qui profitent de ce que Lyra sait déjà (périmètre, période, graphe).

## Conception

### 1. Fiches

Types et champs (tous facultatifs sauf le titre ; chaque champ rempli porte sa citation, vérifiée comme aujourd'hui :
retrouvée dans la page) :

| Type | Vient de | Champs |
|---|---|---|
| `incident` | post-mortem, incident, compte rendu de crise | titre, date, symptômes, messages d'erreur (recopiés tels quels), cause, solution (ce qui a remis en service), actions correctives, tickets, applications et serveurs touchés |
| `correctif` | note de version, mise en production, changement | titre (le problème corrigé), version, date de mise en production, application, tickets, incident lié si la page le cite |
| `procedure` | runbook, exploitation, installation, tuto | titre, but (« relancer Ondine Paiements »), quand l'utiliser, prérequis, étapes (résumées, dans l'ordre), précautions, applications et serveurs |
| `pratique` | bonnes pratiques, règles, référentiels, glossaire | sujet, règles (liste courte), applications si la page en vise |

Chaque fiche porte aussi : la page (identifiant, titre, lien Confluence), la **section** d'où elle vient (titre de la
section et ancre du lien quand la page en a), la période de la page (déjà lue et prouvée par la lecture actuelle), la
date de la page, et des **mots de recherche** rendus par l'IA (synonymes, formulations d'un utilisateur, noms courts
des applications), qui servent seulement à la recherche et ne sont jamais montrés comme un fait.

Une page peut donner plusieurs fiches (une note de version avec six corrections : six `correctif` ; un dossier
d'exploitation : une `procedure` par procédure). Une page qui n'est d'aucun de ces types n'en donne pas (compte rendu de
réunion ordinaire, page de projet, page sans rapport) ; elle reste cherchable par ses sections (voir 3).

**Lecture des fiches** : un **second appel IA**, distinct de la lecture actuelle, seulement pour les pages dont la
nature lue est `incident`, `release`, `operations`, `install` ou `other` (pour les tutos et bonnes pratiques classés
`other`). La lecture actuelle, mesurée et stable, n'est pas touchée. Même découpage par morceaux, mêmes consignes de
l'entreprise, même règle « sans citation retrouvée, le champ est écarté », même nettoyage (adresses électroniques,
numéros de téléphone ; en plus : tout ce qui ressemble à un mot de passe ou un jeton est retiré d'une étape). Version
propre (`OPS_VERSION`) et empreinte propre : changer les consignes des fiches ne fait relire que les fiches.

Rattachement : les applications et serveurs d'une fiche sont rapprochés comme dans la lecture actuelle (périmètre,
inventaire) ; un nom non reconnu reste du texte dans la fiche, sans lien. Le lien `correctif` vers `incident` est fait
par le code quand les deux citent le même ticket, ou par l'IA quand la note de version cite l'incident (avec citation).

### 2. Fiches dans le graphe

- Nœud `fiche` (`attrs.kind` = `incident`, `correctif`, `procedure`, `pratique`), créé par la lecture, purgé et recréé
  quand la page est relue (même règle que les liens d'une page aujourd'hui), marqué retiré si sa page disparaît.
- Liens : `concerne` (fiche vers application ou serveur), `vient_de` (fiche vers document), `corrige` (correctif vers
  incident). Ces liens ne sont **jamais** suivis par l'impact, la carte, le score ou les compteurs : ils sont ajoutés à
  la liste des types ignorés par ces calculs.
- Une fiche `procedure` ou `pratique` d'une page ancienne garde la période `past`. Les fiches `incident` et `correctif`
  décrivent le passé par nature : elles ne sont jamais dites « anciennes » ni pénalisées pour leur période ; elles sont
  classées par pertinence puis par date.
- **Procédure remplacée** (choix du constructeur, à vérifier à la relecture) : la lecture des fiches rend, si la page le
  dit, un champ `remplace` (titre ou lien de la procédure remplacée, avec citation). En fin de passage, comme la revue
  actuelle, le code cherche la procédure visée : d'abord par le lien Confluence cité, sinon par la même application et
  un but très proche (mêmes mots après normalisation) ; la trouvée est marquée `remplacée` avec la citation. Sans phrase
  « remplace », rien n'est marqué : la plus ancienne passe simplement après la plus récente à pertinence égale. La page
  du banc qui remplace une procédure le dira explicitement.

### 3. Recherche

Écrite dans le projet, en mémoire, reconstruite à chaque fin de synchro et au démarrage :

1. **Index par mots-clés (BM25)** sur les fiches (titre, symptômes, messages d'erreur, but, étapes, règles, mots de
   recherche) et, en second recours, sur les sections des pages récupérées (pour les pages sans fiche). Texte normalisé
   comme les citations (casse, accents) ; les noms techniques (serveurs, files, codes d'erreur, versions) sont gardés
   entiers en plus d'être découpés.
2. **Contexte du graphe** : les applications et serveurs de la question donnent un bonus aux fiches qui les
   concernent, un bonus moindre à celles de leurs **voisines** ; une procédure ou une pratique ancienne ou remplacée est
   pénalisée ; à score proche, la plus récente passe devant.
   - Applications et serveurs de la question (choix du constructeur) : le code les rapproche des entités connues avec
     ce qui existe déjà (`matcher.scanText`, `repo.resolve` : noms, variantes, sigles, FQDN), plus l'argument
     `application` donné par le modèle. C'est un rapprochement avec des noms connus, pas du repérage dans les pages :
     la règle du 23/11 ne s'y oppose pas. Aucun appel IA de plus par question.
   - Voisines (choix du constructeur) : les applications liées directement (`calls`, `depends_on`, `reads_from`,
     `writes_to`, dans les deux sens) et celles qui partagent un serveur, une base ou une file actifs (deux pas dans le
     graphe, en passant par l'infrastructure commune) : c'est le « même socle » de l'exemple Brocéliande.
3. **Reclassement** (facultatif) : les vingt premiers résultats sont reclassés par le modèle de reclassement de la
   passerelle ; sinon l'ordre de l'étape 2 est gardé. Il n'est pas testable sur le banc (Ollama n'en sert pas), donc
   (choix du constructeur) : interrupteur à part `KNOWLEDGE_RERANK=false` par défaut, chemin réglable
   `KNOWLEDGE_RERANK_PATH=/rerank` (relatif à `LLM_BASE_URL`, format d'appel le plus courant : `model`, `query`,
   `documents`, réponse `results[].index` et `relevance_score`) ; `doctor` l'essaie seulement s'il est activé et dit ce
   qu'il obtient. **À vérifier au travail** : la page de la passerelle décrit-elle un point d'accès de reclassement ou
   d'embeddings (le `/models` de la passerelle, affiché par `doctor`, le dira aussi) ? Si un modèle d'embeddings est
   bien disponible, il pourra s'ajouter plus tard à l'étape 1 sans rien changer d'autre.

Une fiche « similaire » est une fiche bien classée qui ne concerne pas l'application demandée : elle est rendue avec
`autreApplication: true` pour que l'assistant le dise.

### 4. Assistant

Deux outils ajoutés aux quatre existants (mode natif et mode JSON) :

- `search_knowledge(query, application?)` : les dix meilleures fiches (id, type, titre, application, période, date,
  extrait de la partie qui correspond, lien de la page, `autreApplication`), puis au plus cinq sections de pages.
- `open_fiche(id)` : la fiche complète avec ses citations, son lien et sa section.

Consignes ajoutées au système : chercher avant de répondre à toute question de dépannage, de procédure ou de pratique ;
donner la solution ou les étapes **telles que la fiche les donne** ; citer chaque source par son titre et son lien ;
dire quand la procédure est ancienne, vient d'une autre application, ou quand rien n'a été trouvé ; ne jamais compléter
une étape de mémoire.

Contrôle par le code, après la réponse :

- chaque lien de la réponse doit figurer dans les résultats d'outils de cette question ; sinon il est retiré et la
  réponse est marquée « lien retiré » dans la trace ;
- la réponse rend la liste `sources` (fiches et pages réellement ouvertes ou citées), affichée par l'interface ;
- nombre d'étapes borné comme aujourd'hui (`maxRounds`) ;
- les liens retirés par le contrôle sont rendus dans la trace (`removedLinks`) : le banc les compte.

### 5. Interface

- **Chat** : sous la réponse, les sources en cartes (type, titre, application, date, « ancienne » ou « autre
  application » si c'est le cas), cliquables vers la page Confluence.
- **Page d'une application** : bloc « Documentation opérationnelle » avec ses procédures, incidents connus, correctifs
  et bonnes pratiques, triés par date, avec leur lien.

### 5 bis. Mode démo

Choix du constructeur : le jeu de démonstration (`demo/generate.js`) reçoit quelques fiches fictives et le chat simulé
(`demo/chatMock.js`) rend des sources, pour que le bloc « Documentation opérationnelle » et les cartes de sources ne
soient pas vides en démonstration.

### 6. Mesure sur le banc d'essai

Le banc reçoit des pages nouvelles, toutes fictives :

- procédures : relance, purge de file, rotation de certificat, bascule de reprise, restauration de sauvegarde, accès
  d'astreinte ; dont des doublons proches (même procédure pour deux applications), une version périmée remplacée par
  une plus récente, et une procédure sans équivalent pour certaines applications ;
- incidents avec de vrais messages d'erreur, des causes et des solutions, et des notes de version qui corrigent
  certains d'entre eux (même ticket cité) ;
- tutos et bonnes pratiques ;
- des pages de bruit qui emploient les mêmes mots sans répondre (pour mesurer les faux résultats).

Et une liste d'environ quarante questions, chacune avec la fiche ou la page attendue, les éléments attendus dans la
réponse, ou « rien à trouver ». Notation (choix du constructeur) : par le code, sans IA juge. La recherche est mesurée
sur la question brute (appel direct de la recherche, déterministe) ; la réponse du chat est jugée sur la présence du bon
lien et des éléments attendus (mots clés de la solution, étapes dans l'ordre), et « rien trouvé » sur une formule
reconnue ; `chat.md` reste relu à la main en complément. Le banc privé (générateur, vérité, notation) fait partie du
travail. La notation mesure :

| Mesure | Objectif |
|---|---|
| Bonne source parmi les trois premiers résultats de `search_knowledge` | 90 % ou plus |
| Réponse qui donne la bonne solution ou les bonnes étapes, avec le bon lien | 85 % ou plus |
| Questions sans réponse : Lyra dit n'avoir rien trouvé | 90 % ou plus |
| Liens inventés dans les réponses (avant contrôle du code) | suivi, 0 après contrôle |
| Procédure ancienne ou d'une autre application présentée comme actuelle ou comme la bonne | 0 |
| Champs de fiche écartés faute de citation | suivi |
| Mesures actuelles du banc (impact, période, responsables...) | inchangées |
| Durée de la synchro et nombre d'appels IA en plus | suivi |

## Reprise et coûts

- Au premier passage après la mise à jour, les pages opérationnelles reçoivent leur second appel (pas de relecture des
  autres) ; ensuite seules les pages modifiées.
- Sur le banc, environ la moitié des pages sont opérationnelles : de l'ordre de 75 appels de plus pour 150 pages.

## Suite prévue (pas dans ce lot)

- **Depuis une alerte Naemon** : un serveur ou un service en rouge ouvre directement les fiches de ses applications
  (incidents passés, procédures), avec la même recherche.
- **Depuis un ticket** : coller un ticket, retrouver les antécédents.

## Laissé au constructeur

- Format exact des fiches dans le store et des réponses d'API, noms des fichiers.
- Paramètres de BM25 et poids des bonus, réglés sur le banc.
- Découpage du travail en étapes et ordre des tests.
