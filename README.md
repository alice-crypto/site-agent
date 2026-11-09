# site-agent

Agent qui surveille vos sites en ligne et les met à jour selon des règles que vous définissez. Vous lui associez n'importe quel site à la demande, et vous le lancez sur un site ou sur tous. Il couvre quatre cas : dépendances, nouveau code, contenu et réparation des pannes. Chaque changement est testé, vérifié après déploiement et annulé en cas de problème.

Il fonctionne sans dépendance externe. Il faut Node.js 20 ou plus récent, ainsi que Git.

## Interface graphique

Sous Windows, double-cliquez sur `Site Agent.cmd`. Vous pouvez aussi lancer cette commande :

```bash
npm run ui
```

Le tableau de bord s'ouvre dans le navigateur. Tout s'y fait : associer un site, simuler, passer en mode réel, valider ou refuser une mise à jour, régler les facteurs de décision, lire l'historique et activer la surveillance.

Pour le découvrir sans brancher de vrai site, cette commande ouvre trois sites factices :

```bash
npm run ui:demo
```

La démo s'ouvre sans compte, puisque ses sites sont factices.

Pour la surveillance, le bouton du haut suit tous les sites tant que l'interface tourne. Pour une surveillance permanente sur un serveur, utilisez plutôt `daemon`, décrit plus bas.

## Équipe et comptes

Chaque personne a son propre compte et son rôle :

| Rôle | Peut |
|---|---|
| Lecteur | Consulter les sites, leur état et leur historique |
| Opérateur | En plus : simuler, lancer un cycle, valider ou refuser une mise à jour, relancer un site en pause |
| Administrateur | Tout : associer des sites, passer en mode réel, modifier les règles et les commandes, gérer l'équipe, activer la surveillance |

> Un administrateur écrit des commandes que la machine exécute : ce rôle équivaut à un accès complet au serveur. Réservez-le à une ou deux personnes de confiance.

**Premier lancement :**
1. `Site Agent.cmd` ouvre un lien d'installation. Il ne sert qu'une fois et ne se partage pas.
2. Vous y créez le compte administrateur.
3. Si vous fermez l'onglet avant, relancez `Site Agent.cmd` : le lien se rouvre.

**Inviter quelqu'un :**
1. Dans **Équipe**, saisissez son e-mail et son rôle.
2. Envoyez-lui le lien obtenu par un canal privé. Il est valable 48 h, à usage unique.
3. La personne y choisit elle-même son mot de passe : personne d'autre ne le connaît.

**Mot de passe oublié :** un administrateur clique sur **Nouveau lien** en face de la personne. L'ancien mot de passe reste valable jusqu'à ce que le nouveau lien soit utilisé.

**Sécurité :**
- **Mots de passe :** au moins 12 caractères. Seule une empreinte irréversible (scrypt) est conservée, dans `.site-agent/users.json`.
- **Essais en série :** après 5 échecs, l'adresse est bloquée 15 minutes.
- **Sessions :** elles expirent après 12 h d'inactivité, et au plus tard après 7 jours. Redémarrer l'interface déconnecte tout le monde.
- **Désactivation, changement de rôle ou de mot de passe :** l'effet est immédiat, sans attendre une reconnexion.
- **Contrôle côté serveur :** chaque action est vérifiée sur le serveur. Masquer un bouton ne suffirait pas.
- **Journal d'audit :** chaque action est enregistrée avec son auteur dans `.site-agent/audit.jsonl`, sans jamais de mot de passe.

**En secours, depuis la ligne de commande :** utile si plus aucun administrateur ne peut se connecter.

```bash
node src/cli.js user list
```

```bash
node src/cli.js user invite admin@exemple.fr
```

```bash
node src/cli.js user disable personne@exemple.fr
```

**Accès à distance :** n'exposez jamais l'interface directement sur Internet. Pour la rendre accessible à une équipe, suivez le guide [Installer Site Agent sur un serveur Windows](docs/installation-windows-server.md). Il la place derrière HTTPS, en fait un service permanent et met en place la sauvegarde quotidienne.

## Ajouter un site par son adresse Git

Sur un serveur, le plus simple est de donner l'adresse du dépôt plutôt qu'un dossier : l'agent crée lui-même sa copie dédiée dans `checkouts/`. Les adresses SSH et HTTPS sont acceptées. Le clonage n'attend jamais de saisie : s'il faut un mot de passe, il échoue avec un message clair au lieu de bloquer l'agent.

Le reste de ce document décrit la ligne de commande, qui offre les mêmes fonctions, et le détail des réglages.

## Associer un site

Un site a besoin d'une copie Git sur la machine de l'agent et d'une adresse à surveiller. Il peut être écrit dans n'importe quel langage.

```bash
node src/cli.js add mon-site --dir "C:\sites\mon-site" --url https://mon-site.fr --deploy "npm run deploy"
```

L'agent analyse le dossier sans le modifier. Il repère la branche et le dépôt distant, puis les commandes de `package.json` s'il y en a un. Les options `--install`, `--test`, `--build`, `--deploy` et `--restart` remplacent ce qu'il a trouvé : indiquez-les pour un site qui n'utilise pas Node.js.

**Tout site associé démarre en simulation** : l'agent décide et affiche ses décisions, sans rien modifier.

```bash
node src/cli.js run mon-site
```

Quand les décisions vous conviennent, passez ce site en réel :

```bash
node src/cli.js live mon-site
```

> **Utilisez une copie dédiée à l'agent, pas votre dossier de travail.** En mode réel, il y fait des `git reset --hard` lors des retours arrière. Il refuse d'agir s'il y trouve des modifications non enregistrées, mais personne ne doit y travailler. Un même dossier ne peut pas être associé à deux sites.

## Commandes

| Commande | Rôle |
|---|---|
| `add <site> --dir … --url …` | Associe un site, en simulation |
| `list` | Affiche les sites associés |
| `live <site>` / `simulate <site>` | Change le mode d'un site |
| `remove <site>` | Retire un site, sans toucher à ses fichiers ; son historique est conservé |
| `run <site>` | Exécute un cycle sur ce site |
| `run --all` | Exécute un cycle sur tous les sites, chacun dans son mode |
| `daemon [site…]` | Surveille en continu tous les sites, ou ceux indiqués |
| `status [site]` | Affiche le détail d'un site, ou le résumé de tous |
| `approve <site> <id>` | Autorise un changement, appliqué au cycle suivant |
| `reject <site> <id>` | Refuse un changement définitivement |
| `resume <site>` | Relance un site mis en pause |

`run <site> --live` et `run <site> --dry-run` forcent un mode pour un seul cycle. `run --all --live` est volontairement refusé : le passage en réel se décide site par site.

`daemon` n'a pas besoin d'être relancé : un site ajouté, retiré ou modifié est pris en compte en une minute environ. Sur un serveur, faites-le tourner avec un gestionnaire de services (systemd, pm2…). Chaque site a sa propre boucle : un déploiement long ou une panne ne retarde pas les autres.

## Fonctionnement

À chaque cycle, pour un site, l'agent :

1. **mesure sa santé** (disponibilité, taux d'erreur, latence) et répare si besoin ;
2. **détecte les changements** disponibles et évalue leur risque ;
3. **décide** pour chacun, à partir de vos règles ;
4. **exécute au plus un changement** : installation, tests, build, déploiement ;
5. **vérifie le site** et revient à la version précédente en cas d'échec.

Un seul déploiement par cycle : si le site tombe, le changement responsable est connu. Les autres passent aux cycles suivants.

## Régler les facteurs de décision

Les réglages sont sur deux niveaux :

- [agent.defaults.json](agent.defaults.json) : les règles communes à tous les sites.
- `sites/<site>.json` : le fichier créé par `add`. Tout ce que vous y écrivez remplace le réglage commun pour ce site. Une liste, comme `policy.rules`, est remplacée entière.

| Facteur | Réglage | Effet |
|---|---|---|
| Calendrier | `schedule.windows` | Hors plage, la mise à jour est reportée, sauf règle `bypassWindow` |
| Période de gel | `schedule.freezes` | Tout est reporté, y compris les changements approuvés et les failles graves |
| Santé | `health` | Site instable : aucune mise à jour, seulement de la réparation |
| Gravité | `policy.rules` (`severity`, `updateKind`, `risk`) | Choisit entre `auto`, `approval` et `deny` |
| Événement externe | `webhook` | Lance une vérification immédiate, soumise aux mêmes règles |
| Quota | `policy.maxAutoPerDay` | Plafonne les déploiements automatiques sur 24 h, par site |

Exemple : un site de vente qui se gèle pour les soldes et valide tout à la main.

```json
{
  "schedule": { "freezes": [{ "from": "2027-01-06", "to": "2027-02-02" }] },
  "policy": { "rules": [] }
}
```

### Comment le risque est évalué

| Type | Faible | Moyen | Élevé |
|---|---|---|---|
| Dépendance | Version corrective | Version mineure, ou correctif de dépendances indirectes | Version majeure ou préversion |
| Code | Peu de fichiers et de lignes (`maxLowRisk*`) | Changement plus gros | Touche un chemin de `sensitivePaths` |
| Contenu | Peu de lignes modifiées (`maxLowRiskChangeRatio`) | Modification importante ou nouveau fichier | — |

### Écrire des règles

Les règles sont lues dans l'ordre et la première qui correspond s'applique. Sans correspondance, c'est `policy.default` qui décide : gardez `approval`, pour que tout cas imprévu demande une validation.

```json
{
  "name": "Faille grave corrigeable sans rupture",
  "when": { "type": "dependency", "severity": ["critical", "high"], "updateKind": ["patch", "minor", "transitive"] },
  "action": "auto",
  "bypassWindow": true
}
```

Critères disponibles dans `when` :

- **Tous les types** : `type` (`dependency`, `code`, `content`) et `risk`.
- **Dépendances** : `severity` et `updateKind` (`patch`, `minor`, `major`, `unknown`, `transitive`).
- **Contenu** : `source`.

### Suivre un contenu externe

`add` n'active pas le contenu, car l'agent ne peut pas deviner sa source. Ajoutez-la dans `sites/<site>.json` :

```json
{
  "detectors": {
    "content": {
      "enabled": true,
      "sources": [
        {
          "name": "catalogue",
          "url": "https://example.com/api/catalogue.json",
          "target": "public/catalogue.json",
          "format": "json",
          "requiredKeys": ["items"]
        }
      ]
    }
  }
}
```

## Garde-fous

- **Retour arrière** : si le déploiement ou la vérification échoue, l'agent redéploie la version précédente et bloque le changement fautif.
- **Publication** : le `git push` n'a lieu qu'après une vérification réussie.
- **Approbation** : elle ne vaut que pour la version exacte. Un nouveau commit ou un nouveau contenu demande une nouvelle validation.
- **Coupe-circuit** : après `maxConsecutiveFailures` échecs de suite, le site se met en pause jusqu'à un `resume`. Les autres sites continuent.
- **Pannes** : l'agent redémarre, puis revient à la dernière version saine. Si le site reste en panne, il le met en pause et vous alerte. `cooldownMinutes` et `maxPerDay` évitent les boucles de réparation.

## Secrets et alertes

Les secrets restent hors de la configuration, dans des variables d'environnement :

- `SITE_AGENT_WEBHOOK_SECRET` : secret partagé du webhook. Un site peut avoir le sien avec `webhook.secretEnv`.
- `SITE_AGENT_NOTIFY_WEBHOOK` : URL recevant les alertes au format `{ "text": "..." }`, compatible avec Slack. Le nom du site figure dans chaque alerte.

Pour activer le webhook, passez `webhook.enabled` à `true` dans [agent.defaults.json](agent.defaults.json). Chaque site a son adresse : `POST /webhook/<site>`. Pour GitHub, indiquez cette adresse et le secret dans les paramètres du dépôt. Le serveur écoute sur `127.0.0.1` par défaut : pour le recevoir depuis Internet, placez-le derrière un proxy HTTPS.

## Limites actuelles

- **Git obligatoire** : un site sans copie Git accessible (WordPress géré seulement en ligne, hébergement par FTP sans dépôt) ne peut pas être associé, car le retour arrière en dépend.
- **Dépendances** : npm uniquement. Les autres sites profitent du suivi du code, du contenu et des pannes.
- **Santé** : une vérification ne voit que ce qu'elle interroge. Choisissez une page qui sollicite vraiment le site (plusieurs `--url` possibles), et utilisez `health.mustContain`.
- **Réseau** : l'agent ne distingue pas une panne du site d'une coupure de sa propre machine. Faites-le tourner au plus près des sites.
- **Migrations de base de données** : un retour arrière Git ne les annule pas. Gardez ces chemins dans `sensitivePaths`, avec une validation humaine.
- **Contenu externe** : il est écrit tel quel après validation de son format, donc le site doit l'échapper à l'affichage.

## Essayer et tester

```bash
npm run demo
```

```bash
npm test
```
