# Consignes de lecture pour l'IA

Ce fichier est lu à chaque analyse de page. Copiez-le en `consignes-ia.md` (ce que fait
`npm run setup`) puis remplacez les exemples par vos conventions. Il n'est pas versionné.
Écrivez des phrases simples, une règle par ligne. Au-delà de 8 000 caractères, la fin est ignorée.
Modifier ce fichier relance l'analyse des pages au prochain passage.

## Noms des serveurs

Expliquez comment se construisent les noms, pour que l'IA reconnaisse un serveur dans une page.

Exemple fictif : les serveurs s'appellent `srv` suivi de trois lettres pour le site, de deux
lettres pour le rôle (`ap` application, `bd` base de données) et d'un numéro à deux chiffres,
par exemple `srvparap01`. Les noms qui finissent par `-old` sont des machines arrêtées.

## Environnements

Dites quels mots désignent la production, la préproduction et le développement chez vous.
Les valeurs possibles sont PRD, STG et DEV. Déclarez aussi ces mots dans le bloc `environnements`
de `mappings.json` : il sert aux inventaires et au contrôle de l'environnement d'une page (une page
« recette » n'est rattachée à STG que si « recette » y est déclaré).

Exemple fictif : « recette » et « UAT » désignent STG. « Intégration » désigne DEV.
« Exploitation » désigne PRD.

## Vocabulaire

Donnez le sens des sigles, des noms d'outils ou des surnoms d'applications utilisés dans vos pages.

Exemple fictif : « la caisse » est le surnom de l'application OrderHub. « BDD métier » désigne
la base de données principale de l'application. « Frontal » désigne un serveur web.

## Pages à ignorer

Listez les types de pages qui ne décrivent pas l'architecture actuelle et qui ne doivent pas
produire de serveurs ni de liens.

Exemple fictif : les comptes rendus de réunion, les pages dont le titre commence par
« Brouillon » et les pages d'archive d'avant 2020 décrivent des projets, pas l'existant.
