#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Installe Site Agent comme service permanent sur un serveur Windows, derrière Caddy pour le HTTPS.

.DESCRIPTION
  À lancer une seule fois, dans PowerShell ouvert en tant qu'administrateur, depuis le dossier de Site Agent.
  Le script peut être relancé sans risque : chaque étape vérifie d'abord ce qui existe déjà.

  Ce qu'il fait :
    1. vérifie Node.js, Git et Caddy ;
    2. crée le compte Windows dédié « site-agent », sans droits d'administrateur ;
    3. donne à ce compte l'accès au dossier de Site Agent ;
    4. déclare l'adresse publique dans agent.defaults.json ;
    5. crée deux tâches planifiées qui démarrent avec le serveur et redémarrent en cas d'arrêt :
       Site Agent (compte dédié) et Site Agent - Caddy (HTTPS) ;
    6. ouvre les ports 80 et 443 du pare-feu, et seulement ceux-là (ou le seul port -HttpsPort) ;
    7. démarre le tout et affiche le lien de création du premier administrateur.

  Sur un réseau local (adresse IP ou nom interne), Caddy crée ses propres certificats : le script
  fournit alors le certificat racine à installer sur les PC de l'équipe, et n'ouvre le pare-feu
  qu'au réseau local.

  Si IIS ou un autre serveur web occupe déjà les ports 80 et 443, choisissez un autre port avec
  -HttpsPort : l'agent répondra par exemple sur https://10.10.10.18:8443, sans toucher à IIS.

.EXAMPLE
  .\deploy\windows\install.ps1 -Domain agent.mon-entreprise.fr

.EXAMPLE
  .\deploy\windows\install.ps1 -Address 10.10.10.18

.EXAMPLE
  .\deploy\windows\install.ps1 -Address 10.10.10.18 -AllowFrom 10.10.0.0/16

.EXAMPLE
  .\deploy\windows\install.ps1 -Address 10.10.10.18 -HttpsPort 8443
#>
param(
  [Parameter(Mandatory = $true)]
  [Alias('Address')]
  [string] $Domain,
  [string] $InstallDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [string] $ServiceUser = 'site-agent',
  [string] $CaddyPath = 'C:\caddy\caddy.exe',
  [int] $Port = 4310,
  # Nom interne (ex. agent.intranet) qui n'est pas joignable depuis Internet : certificats internes.
  [switch] $Internal,
  # Qui peut joindre l'agent. Par défaut : le réseau local en interne, tout le monde sinon.
  [string[]] $AllowFrom,
  # Port HTTPS de l'agent. Changez-le si IIS ou un autre serveur web occupe déjà le port 443.
  [ValidateRange(1, 65535)]
  [int] $HttpsPort = 443
)

$ErrorActionPreference = 'Stop'
$AgentTask = 'Site Agent'
$CaddyTask = 'Site Agent - Caddy'

function Write-Step([string] $Message) {
  Write-Host ''
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Get-PlainText([securestring] $Secure) {
  return [System.Net.NetworkCredential]::new('', $Secure).Password
}

# Une tâche planifiée qui démarre avec le serveur et redémarre toute seule en cas d'arrêt.
# Au démarrage du serveur, puis toutes les 5 minutes : si le programme s'est arrêté, il est relancé ;
# s'il tourne déjà, MultipleInstances IgnoreNew ne fait rien.
function New-ServiceTriggers {
  return @(
    (New-ScheduledTaskTrigger -AtStartup),
    (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
      -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650))
  )
}

function New-ServiceSettings {
  return New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries
}

Write-Step 'Vérification des prérequis'
$IsIpAddress = $Domain -match '^\d{1,3}(\.\d{1,3}){3}$'
if ($IsIpAddress) {
  if ($Domain.Split('.') | Where-Object { [int]$_ -gt 255 }) { throw "Adresse IP invalide : $Domain" }
} elseif ($Domain -notmatch '^(?=.{2,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$') {
  throw "Adresse invalide : $Domain. Exemples : agent.mon-entreprise.fr ou 10.10.10.18"
}
# Un certificat public n'est délivré que pour un nom joignable depuis Internet : sinon, Caddy signe lui-même.
$UseInternalTls = $IsIpAddress -or $Internal -or ($Domain -notmatch '\.')
if (-not $AllowFrom) { $AllowFrom = if ($UseInternalTls) { @('LocalSubnet') } else { @('Any') } }
if ($HttpsPort -eq $Port) { throw "Le port HTTPS ne peut pas être celui de l'agent ($Port)." }
# Let's Encrypt vérifie le domaine sur les ports 80 ou 443 : un autre port n'est possible qu'avec un certificat interne.
if ($HttpsPort -ne 443 -and -not $UseInternalTls) {
  throw "-HttpsPort n'est possible qu'en réseau local (adresse IP ou -Internal) : un certificat public exige les ports 80 et 443."
}
$PublicUrl = if ($HttpsPort -eq 443) { "https://$Domain" } else { "https://${Domain}:$HttpsPort" }
# Avec le port standard, Caddy écoute aussi sur le port 80 pour rediriger vers HTTPS.
$WebPorts = if ($HttpsPort -eq 443) { @(80, 443) } else { @($HttpsPort) }
$Busy = Get-NetTCPConnection -LocalPort $WebPorts -State Listen -ErrorAction SilentlyContinue |
  Where-Object { (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName -ne 'caddy' }
if ($Busy) {
  $BusyPorts = ($Busy.LocalPort | Sort-Object -Unique) -join ', '
  $Hint = if ($UseInternalTls) { 'Relancez avec un port libre, par exemple : -HttpsPort 8443' } else { 'Libérez ces ports, ou installez l''agent en réseau local avec -HttpsPort.' }
  throw "Le port $BusyPorts est déjà utilisé sur ce serveur (souvent par IIS). $Hint"
}
Write-Host "Adresse : $PublicUrl (certificat $(if ($UseInternalTls) { 'interne' } else { 'public, Let''s Encrypt' })). Accès autorisé depuis : $($AllowFrom -join ', ')"
$Node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $Node) { throw 'Node.js est introuvable. Installez la version LTS depuis https://nodejs.org puis relancez ce script.' }
$NodeVersion = [version]((& $Node --version).TrimStart('v'))
if ($NodeVersion.Major -lt 20) { throw "Node.js $NodeVersion est trop ancien : il faut la version 20 ou plus récente." }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'Git est introuvable. Installez Git for Windows depuis https://git-scm.com puis relancez ce script.' }
if (-not (Test-Path $CaddyPath)) { throw "Caddy est introuvable à $CaddyPath. Téléchargez caddy.exe (Windows amd64) depuis https://caddyserver.com/download et placez-le à cet endroit." }
if (-not (Test-Path (Join-Path $InstallDir 'src\cli.js'))) { throw "Site Agent est introuvable dans $InstallDir." }
Write-Host "Node.js $NodeVersion, Git et Caddy trouvés. Dossier : $InstallDir"

Write-Step "Compte Windows dédié « $ServiceUser »"
# Un contrôleur de domaine n'a pas de comptes locaux : l'agent doit être installé sur un serveur membre.
if ((Get-CimInstance Win32_ComputerSystem).DomainRole -ge 4) {
  throw "Ce serveur est un contrôleur de domaine, qui n'a pas de comptes locaux. Installez Site Agent sur un autre serveur."
}
$Existing = Get-LocalUser -Name $ServiceUser -ErrorAction SilentlyContinue
if ($Existing) {
  $Password = Read-Host "Mot de passe du compte $ServiceUser" -AsSecureString
} else {
  Write-Host "Ce compte fera tourner l'agent. Choisissez un mot de passe long ; vous n'aurez pas à le retenir au quotidien."
  $Password = Read-Host "Nouveau mot de passe pour $ServiceUser" -AsSecureString
  $Confirm = Read-Host 'Confirmez le mot de passe' -AsSecureString
  if ((Get-PlainText $Password) -ne (Get-PlainText $Confirm)) { throw 'Les deux mots de passe ne correspondent pas.' }
  New-LocalUser -Name $ServiceUser -Password $Password -PasswordNeverExpires -UserMayNotChangePassword `
    -Description 'Compte de service de Site Agent' | Out-Null
  Write-Host "Compte créé, sans droits d'administrateur."
}
# Le nom « MACHINE\compte » ne se résout pas toujours (serveur membre d'un domaine, nom renommé) :
# les droits sont donnés par l'identifiant de sécurité (SID), qui est sans ambiguïté.
$ServiceSid = (Get-LocalUser -Name $ServiceUser).SID
$ServiceAccount = try { $ServiceSid.Translate([System.Security.Principal.NTAccount]).Value } catch { ".\$ServiceUser" }
Write-Host "Compte : $ServiceAccount ($($ServiceSid.Value))"

Write-Step 'Droits sur le dossier de Site Agent'
foreach ($Folder in 'logs', 'checkouts', 'backups', '.site-agent', 'sites') {
  New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir $Folder) | Out-Null
}
& icacls $InstallDir /grant "*$($ServiceSid.Value):(OI)(CI)M" /T /Q | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Impossible de donner les droits sur $InstallDir." }
# Les comptes et l'historique ne doivent être lisibles que par le compte de service et les administrateurs.
& icacls (Join-Path $InstallDir '.site-agent') /inheritance:r /grant:r "*$($ServiceSid.Value):(OI)(CI)M" `
  '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-18:(OI)(CI)F' /T /Q | Out-Null
Write-Host 'Droits accordés.'

Write-Step 'Adresse publique'
$DefaultsPath = Join-Path $InstallDir 'agent.defaults.json'
$Defaults = Get-Content -Raw -Encoding UTF8 $DefaultsPath | ConvertFrom-Json
$Ui = [pscustomobject]@{ port = $Port; publicUrl = $PublicUrl }
if ($Defaults.PSObject.Properties.Name -contains 'ui') { $Defaults.ui = $Ui } else { $Defaults | Add-Member -NotePropertyName ui -NotePropertyValue $Ui }
[System.IO.File]::WriteAllText($DefaultsPath, ($Defaults | ConvertTo-Json -Depth 20), [System.Text.UTF8Encoding]::new($false))
Write-Host "Site Agent répondra sur $PublicUrl"

Write-Step "Tâche « $AgentTask »"
$AgentAction = New-ScheduledTaskAction -Execute 'cmd.exe' `
  -Argument "/c `"`"$Node`" src\cli.js serve >> logs\agent.log 2>&1`"" `
  -WorkingDirectory $InstallDir
Register-ScheduledTask -TaskName $AgentTask -Action $AgentAction -Trigger (New-ServiceTriggers) `
  -Settings (New-ServiceSettings) -User $ServiceAccount -Password (Get-PlainText $Password) `
  -RunLevel Limited -Description 'Surveillance et mise à jour des sites' -Force | Out-Null
Write-Host 'Tâche créée : elle démarre avec le serveur, sous le compte dédié.'

Write-Step "Tâche « $CaddyTask » (HTTPS)"
$CaddyDir = Split-Path $CaddyPath
$Caddyfile = Join-Path $CaddyDir 'Caddyfile'
if ($UseInternalTls) {
  # Hors du port 443, Caddy ne doit pas prendre le port 80 pour ses redirections : il peut être à IIS.
  $GlobalOptions = if ($HttpsPort -eq 443) { '' } else { "{`n`tauto_https disable_redirects`n}`n`n" }
  $CaddyConfig = @"
# Créé par Site Agent. Réseau local : Caddy signe lui-même le certificat avec sa propre autorité.
$GlobalOptions$PublicUrl {
	tls internal
	encode gzip
	reverse_proxy 127.0.0.1:$Port
}
"@
} else {
  $CaddyConfig = @"
# Créé par Site Agent. Caddy obtient et renouvelle le certificat HTTPS tout seul.
$Domain {
	encode gzip
	reverse_proxy 127.0.0.1:$Port
}
"@
}
[System.IO.File]::WriteAllText($Caddyfile, $CaddyConfig, [System.Text.UTF8Encoding]::new($false))
$CaddyAction = New-ScheduledTaskAction -Execute $CaddyPath -Argument "run --config `"$Caddyfile`" --adapter caddyfile" -WorkingDirectory $CaddyDir
# Caddy écoute sur les ports web : il tourne sous le compte système, l'agent non.
Register-ScheduledTask -TaskName $CaddyTask -Action $CaddyAction -Trigger (New-ServiceTriggers) `
  -Settings (New-ServiceSettings) -User 'NT AUTHORITY\SYSTEM' -RunLevel Highest `
  -Description 'HTTPS pour Site Agent' -Force | Out-Null
Write-Host "Caddy configuré dans $Caddyfile"

Write-Step "Pare-feu : port$(if ($WebPorts.Count -gt 1) { 's' }) $($WebPorts -join ' et ') uniquement"
# Une installation précédente sur d'autres ports : ses règles sont retirées.
Get-NetFirewallRule -DisplayName 'Site Agent - HTTPS (*)' -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -notin ($WebPorts | ForEach-Object { "Site Agent - HTTPS ($_)" }) } |
  Remove-NetFirewallRule
foreach ($FirewallPort in $WebPorts) {
  $RuleName = "Site Agent - HTTPS ($FirewallPort)"
  $Rule = Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue
  if ($Rule) {
    # Relancer le script avec un autre -AllowFrom met la règle à jour.
    $Rule | Set-NetFirewallRule -RemoteAddress $AllowFrom
  } else {
    New-NetFirewallRule -DisplayName $RuleName -Direction Inbound -Protocol TCP -LocalPort $FirewallPort `
      -RemoteAddress $AllowFrom -Action Allow | Out-Null
  }
}
Write-Host "Ouverts depuis : $($AllowFrom -join ', ')"
Write-Host "Le port $Port de l'agent reste fermé à l'extérieur : seul Caddy y accède."

Write-Step 'Démarrage'
Stop-ScheduledTask -TaskName $AgentTask -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName $AgentTask
Start-ScheduledTask -TaskName $CaddyTask
$Ready = $false
foreach ($Attempt in 1..20) {
  Start-Sleep -Seconds 1
  try {
    $Session = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/session" -TimeoutSec 2
    if ($Session.service -eq 'site-agent') { $Ready = $true; break }
  } catch { }
}
if (-not $Ready) { throw "L'agent ne répond pas. Consultez $InstallDir\logs\agent.log" }
Write-Host 'Site Agent répond.' -ForegroundColor Green

if ($UseInternalTls) {
  Write-Step 'Certificat racine pour les PC de l''équipe'
  # Caddy tourne sous le compte système : son autorité est rangée dans le profil de ce compte.
  $CaddyRoot = Join-Path $env:SystemRoot 'System32\config\systemprofile\AppData\Roaming\Caddy\pki\authorities\local\root.crt'
  $ExportedRoot = Join-Path $CaddyDir 'site-agent-racine.crt'
  foreach ($Attempt in 1..30) {
    if (Test-Path $CaddyRoot) { break }
    Start-Sleep -Seconds 1
  }
  if (Test-Path $CaddyRoot) {
    Copy-Item $CaddyRoot $ExportedRoot -Force
    Write-Host "Certificat à installer sur chaque PC de l'équipe : $ExportedRoot" -ForegroundColor Yellow
    Write-Host 'Sans lui, les navigateurs afficheront un avertissement de sécurité. Voir le guide, partie « Réseau local ».'
  } else {
    Write-Host "Caddy n'a pas encore créé son certificat. Relancez ce script dans une minute pour le récupérer." -ForegroundColor Yellow
  }
}

Write-Step 'Premier administrateur'
Push-Location $InstallDir
try { & $Node src\cli.js setup-link } finally { Pop-Location }

Write-Host ''
Write-Host 'Installation terminée.' -ForegroundColor Green
if ($UseInternalTls) {
  Write-Host 'Installez d''abord le certificat racine sur votre PC, puis ouvrez le lien ci-dessus.'
} else {
  Write-Host "Ouvrez le lien ci-dessus depuis votre PC. Si le certificat n'est pas encore prêt, attendez une minute :"
  Write-Host "Caddy l'obtient dès que le nom $Domain pointe vers ce serveur."
}
Write-Host 'Étape suivante : créer la clé de déploiement du compte de service (voir le guide, partie 7).'
