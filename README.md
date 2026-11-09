# site-agent

Agent qui surveille vos sites en ligne et les met à jour selon des règles que vous définissez. Vous lui associez n'importe quel site à la demande, et vous le lancez sur un site ou sur tous. Il couvre quatre cas : dépendances, nouveau code, contenu et réparation des pannes. Chaque changement est testé, vérifié après déploiement et annulé en cas de problème.

Il faut :
- **Node.js 20 ou plus récent** et **Git**, pour l'agent ;
- **Python 3.11 ou plus récent** et **PostgreSQL**, pour l'administration des comptes (Django, dossier [webadmin](webadmin)) ;
- **Ollama**, seulement si vous activez l'analyse IA des mises à jour (LangChain).

Installation, une fois :

```bash
npm install
```

```bash
python -m venv webadmin/.venv
```

```bash
webadmin/.venv/Scripts/python -m pip install -r webadmin/requirements/local.txt
```

Copiez ensuite [webadmin/.env.example](webadmin/.env.example) en `webadmin/.env` et indiquez-y la base PostgreSQL.

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

Les comptes sont gérés par **Django**, avec son administration complète à l'adresse `/admin/`, et stockés dans PostgreSQL. L'agent Node.js ne connaît aucun mot de passe : Django lui transmet, pour chaque requête, qui est connecté et avec quel rôle, signé avec une clé partagée. L'agent n'écoute que sur la machine elle-même et refuse toute requête non signée.

Le projet Django suit l'organisation de cookiecutter-django :

| Dossier | Contenu |
|---|---|
| `webadmin/config/` | Réglages (`base`, `local`, `production`, `test`), adresses, routeur de l'API |
| `webadmin/site_agent/users/` | Modèle `User`, rôles, formulaires, administration, API (serializers et vues) |
| `webadmin/site_agent/audit/` | Journal d'audit : modèle, services, administration, API en lecture seule |
| `webadmin/site_agent/agent/` | Passerelle vers l'agent : services (signature, client HTTP), session, vues |

Le rôle vient du groupe Django de la personne :

| Groupe | Peut |
|---|---|
| Lecteurs | Consulter les sites, leur état et leur historique |
| Opérateurs | En plus : simuler, lancer un cycle, valider ou refuser une mise à jour, relancer un site en pause |
| Administrateurs | Tout : associer des sites, passer en mode réel, modifier les règles et les commandes, activer la surveillance, gérer les comptes |

> Un administrateur écrit des commandes que la machine exécute : ce rôle équivaut à un accès complet au serveur. Réservez-le à une ou deux personnes de confiance.

**Premier administrateur :**

```bash
webadmin/.venv/Scripts/python webadmin/manage.py createsuperuser
```

**Ajouter quelqu'un :** dans **Administration → Comptes**, créez le compte, puis ajoutez-le à un groupe. Cochez « Statut équipe » seulement pour qui doit aussi accéder à l'administration.

**Sécurité :**
- **Mots de passe :** au moins 12 caractères, refus des mots de passe courants, empreinte Django (PBKDF2). « Mot de passe oublié » envoie un lien par courriel, si un serveur SMTP est configuré dans `webadmin/.env`.
- **Essais en série :** après 5 échecs, le compte est bloqué 15 minutes.
- **Sessions :** elles expirent après 12 h d'inactivité. Changer son mot de passe déconnecte les autres sessions.
- **Contrôle côté serveur :** le rôle est vérifié par l'agent sur chaque action, d'après l'identité signée par Django.
- **Journal d'audit :** connexions, échecs et chaque action passée à l'agent, avec auteur et adresse IP, dans PostgreSQL. Il se consulte dans l'administration, sans pouvoir être modifié.

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

### Analyse IA des mises à jour

Si vous l'activez (**Règles et facteurs → Analyse IA**), un agent LangChain fait lire chaque mise à jour à un modèle de langage local, servi par [Ollama](https://ollama.com). Le modèle reçoit le journal Git et le diff du code, la nature d'une mise à jour de dépendance et ses avis de sécurité, ou le nouveau contenu. Il rend un risque, une recommandation, un résumé en français et les points à vérifier, affichés à côté de chaque mise à jour.

**L'analyse ne peut que rendre l'agent plus prudent :**
- le risque retenu est le plus élevé entre celui des règles et celui du modèle ;
- si le modèle recommande un regard humain, déconseille le déploiement ou estime le risque élevé, la mise à jour attend une validation ;
- un modèle rassurant n'autorise jamais ce que les règles retiennent. Un diff piégé, qui contiendrait des instructions adressées au modèle, ne peut donc rien débloquer.

Une analyse est gardée tant que la même version reste détectée : le modèle n'est pas réinterrogé à chaque cycle. Si Ollama ne répond pas, l'agent décide avec ses règles seules et vous prévient. Vous pouvez aussi choisir d'exiger alors une validation humaine.

Réglages dans `advisor` ([agent.defaults.json](agent.defaults.json) ou par site) : `enabled`, `model` (par défaut `qwen2.5:7b`), `baseUrl` (par défaut `http://127.0.0.1:11434`), `timeoutSeconds`, `maxDiffChars`, `onError` (`rules` ou `approval`). Gardez Ollama sur la même machine ou sur votre réseau : le code de vos sites lui est envoyé.

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
