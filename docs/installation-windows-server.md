# Installer Site Agent sur un serveur Windows

Ce guide met Site Agent en ligne pour votre équipe, à une adresse comme `https://agent.mon-entreprise.fr`. Comptez environ une heure la première fois.

À la fin :

- l'agent tourne en permanence, même quand personne n'est connecté au serveur ;
- il redémarre tout seul après une panne ou un redémarrage de Windows ;
- l'interface est servie en HTTPS, avec un certificat gratuit renouvelé automatiquement ;
- la configuration, les comptes et l'historique sont sauvegardés chaque jour.

## 1. Louer le serveur

Prenez un serveur virtuel (VPS) **Windows Server 2022 ou 2025** chez l'hébergeur de votre choix. Pour quelques sites, 2 processeurs et 4 Go de mémoire suffisent.

L'hébergeur vous donne :
- l'**adresse IP** du serveur ;
- le **mot de passe administrateur**.

Gardez-les de côté.

## 2. Faire pointer un nom de domaine

Chez le gestionnaire de votre nom de domaine, créez un enregistrement **A** :

| Type | Nom | Valeur |
|---|---|---|
| A | `agent` | l'adresse IP du serveur |

L'agent sera alors accessible à `agent.votre-domaine.fr`. La prise en compte peut prendre de quelques minutes à quelques heures.

## 3. Se connecter au serveur

Sur votre PC, ouvrez **Connexion Bureau à distance** (tapez `mstsc` dans le menu Démarrer). Saisissez l'adresse IP, puis connectez-vous avec le compte administrateur.

Toutes les étapes suivantes se font sur le serveur.

## 4. Installer les trois logiciels nécessaires

| Logiciel | Où le trouver | Remarque |
|---|---|---|
| **Node.js** (version LTS) | https://nodejs.org | Gardez les options par défaut |
| **Git for Windows** | https://git-scm.com | Gardez les options par défaut |
| **Caddy** | https://caddyserver.com/download | Choisissez *Windows amd64*. Renommez le fichier `caddy.exe` et placez-le dans `C:\caddy\` |

## 5. Copier Site Agent sur le serveur

Ouvrez **PowerShell** et récupérez Site Agent depuis GitHub :

```powershell
git clone https://github.com/alice-crypto/site-agent.git C:\site-agent
```

Vous pouvez aussi copier le dossier `site-agent` de votre PC vers `C:\site-agent`. Les fichiers se collent directement dans la fenêtre du Bureau à distance.

## 6. Lancer l'installation

Ouvrez **PowerShell en tant qu'administrateur** : clic droit sur PowerShell, puis *Exécuter en tant qu'administrateur*. Lancez ces commandes, en remplaçant le domaine par le vôtre :

```powershell
cd C:\site-agent
Set-ExecutionPolicy -Scope Process Bypass
.\deploy\windows\install.ps1 -Domain agent.votre-domaine.fr
```

Le script vous demande de choisir un mot de passe pour le compte Windows `site-agent`. C'est ce compte qui fait tourner l'agent, sans droits d'administrateur. Choisissez un mot de passe long, puis notez-le dans votre gestionnaire de mots de passe.

À la fin, le script affiche un **lien d'installation**. Ouvrez-le depuis votre PC pour créer votre compte administrateur. Ce lien ne sert qu'une fois.

> Si le navigateur signale un problème de certificat, attendez une ou deux minutes. Caddy obtient le certificat dès que le nom de domaine pointe vers le serveur (partie 2).

## 7. Donner au serveur l'accès à vos dépôts

L'agent récupère le code de vos sites et y enregistre ses mises à jour. Il lui faut pour cela une **clé de déploiement** : un accès limité à un seul dépôt, que vous pouvez retirer à tout moment.

Toujours dans PowerShell administrateur, ouvrez une fenêtre au nom du compte de service :

```powershell
runas /user:site-agent powershell
```

Dans la nouvelle fenêtre qui s'ouvre, créez la clé et affichez-la :

```powershell
ssh-keygen -t ed25519 -N '""' -f "$env:USERPROFILE\.ssh\id_ed25519"
Get-Content "$env:USERPROFILE\.ssh\id_ed25519.pub"
```

Copiez la ligne affichée, qui commence par `ssh-ed25519`. Dans GitHub, ouvrez chaque dépôt de site, puis **Settings → Deploy keys → Add deploy key**. Collez la ligne et **cochez « Allow write access »**, car l'agent y enregistre les mises à jour qu'il a validées. GitLab et Bitbucket proposent la même chose.

## 8. Ajouter vos sites

Dans l'interface, cliquez sur **Associer un site** :
1. choisissez **Son adresse Git** ;
2. collez l'adresse SSH du dépôt, par exemple `git@github.com:mon-equipe/mon-site.git` ;
3. indiquez l'adresse en ligne du site et sa **commande de déploiement** ;
4. validez : l'agent crée sa propre copie dans `C:\site-agent\checkouts`.

Le site démarre en **simulation**. Lancez quelques simulations et vérifiez les décisions avant de passer en mode réel.

**La commande de déploiement** est ce qui publie le site depuis cette copie. Elle dépend de votre hébergement : copie vers un dossier IIS, envoi FTP, script maison… Elle s'exécute sous le compte `site-agent`, qui doit donc avoir les droits nécessaires sur la destination.

## 9. Inviter l'équipe

Dans **Équipe**, invitez chaque personne avec son rôle, puis envoyez-lui le lien par un canal privé.

Pour la sécurité, gardez **une ou deux personnes au plus** comme administrateurs : ce rôle peut faire exécuter des commandes au serveur.

## Au quotidien

| Besoin | Où regarder |
|---|---|
| L'agent tourne-t-il ? | Planificateur de tâches → *Site Agent* (état « En cours d'exécution ») |
| Journal de l'agent | `C:\site-agent\logs\agent.log` |
| Qui a fait quoi | `C:\site-agent\.site-agent\audit.jsonl` |
| Sauvegardes | `C:\site-agent\backups\` : une par jour, les 14 dernières sont gardées |

**Sauvegardes hors du serveur :** copiez régulièrement le dossier `backups` ailleurs. Une sauvegarde restée sur le serveur ne protège pas contre la perte du serveur.

**Restaurer une sauvegarde :**
1. arrêtez la tâche *Site Agent* ;
2. recopiez `agent.defaults.json`, `sites` et `.site-agent` depuis la sauvegarde choisie ;
3. relancez la tâche.

**Mettre à jour Site Agent :**
1. arrêtez la tâche *Site Agent* ;
2. remplacez les fichiers, par exemple avec `git pull` dans `C:\site-agent` ;
3. relancez la tâche. Vos sites, comptes et historique ne sont pas touchés.

**Commandes de secours** (PowerShell administrateur, dans `C:\site-agent`) :

```powershell
node src\cli.js user list
node src\cli.js user invite admin@votre-domaine.fr
node src\cli.js setup-link
node src\cli.js backup
```

**Tout retirer**, sans effacer les données :

```powershell
.\deploy\windows\uninstall.ps1
```

## Sécuriser le serveur

- **Ports ouverts :** n'ouvrez que les ports 80 et 443 au public, le script ne fait rien d'autre. Le port de l'agent (4310) reste fermé.
- **Bureau à distance :** si votre hébergeur le permet, limitez-le à votre adresse IP, et utilisez un mot de passe administrateur long.
- **Mises à jour Windows :** laissez-les activées.
- **Le dossier `.site-agent` :** il contient les comptes, sous forme d'empreintes et jamais de mots de passe en clair. Le script en réserve l'accès au compte de service et aux administrateurs.

## Dépannage

| Symptôme | Cause probable |
|---|---|
| Le site `https://agent…` ne répond pas | Le nom de domaine ne pointe pas encore vers le serveur, ou la tâche *Site Agent - Caddy* est arrêtée |
| Erreur de certificat | Le domaine vient d'être créé : attendez quelques minutes |
| « Accès refusé » sur la page | L'adresse utilisée ne correspond pas au domaine passé au script. Relancez le script avec le bon domaine |
| « Clonage impossible » à l'ajout d'un site | La clé de déploiement n'est pas ajoutée au dépôt, ou l'adresse n'est pas au format SSH |
| La tâche *Site Agent* ne démarre pas | Mot de passe du compte `site-agent` changé : relancez le script d'installation, il vous le redemandera |
| Plus aucun administrateur ne peut se connecter | `node src\cli.js user invite <email>` crée un nouveau lien |
