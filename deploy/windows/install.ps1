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
    6. ouvre les ports 80 et 443 du pare-feu, et seulement ceux-là ;
    7. démarre le tout et affiche le lien de création du premier administrateur.

.EXAMPLE
  .\deploy\windows\install.ps1 -Domain agent.mon-entreprise.fr
#>
param(
  [Parameter(Mandatory = $true)]
  [string] $Domain,
  [string] $InstallDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [string] $ServiceUser = 'site-agent',
  [string] $CaddyPath = 'C:\caddy\caddy.exe',
  [int] $Port = 4310
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
if ($Domain -notmatch '^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$') {
  throw "Nom de domaine invalide : $Domain. Exemple attendu : agent.mon-entreprise.fr"
}
$Node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $Node) { throw 'Node.js est introuvable. Installez la version LTS depuis https://nodejs.org puis relancez ce script.' }
$NodeVersion = [version]((& $Node --version).TrimStart('v'))
if ($NodeVersion.Major -lt 20) { throw "Node.js $NodeVersion est trop ancien : il faut la version 20 ou plus récente." }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'Git est introuvable. Installez Git for Windows depuis https://git-scm.com puis relancez ce script.' }
if (-not (Test-Path $CaddyPath)) { throw "Caddy est introuvable à $CaddyPath. Téléchargez caddy.exe (Windows amd64) depuis https://caddyserver.com/download et placez-le à cet endroit." }
if (-not (Test-Path (Join-Path $InstallDir 'src\cli.js'))) { throw "Site Agent est introuvable dans $InstallDir." }
Write-Host "Node.js $NodeVersion, Git et Caddy trouvés. Dossier : $InstallDir"

Write-Step "Compte Windows dédié « $ServiceUser »"
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

Write-Step 'Droits sur le dossier de Site Agent'
foreach ($Folder in 'logs', 'checkouts', 'backups', '.site-agent', 'sites') {
  New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir $Folder) | Out-Null
}
& icacls $InstallDir /grant "${env:COMPUTERNAME}\${ServiceUser}:(OI)(CI)M" /T /Q | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Impossible de donner les droits sur $InstallDir." }
# Les comptes et l'historique ne doivent être lisibles que par le compte de service et les administrateurs.
& icacls (Join-Path $InstallDir '.site-agent') /inheritance:r /grant:r "${env:COMPUTERNAME}\${ServiceUser}:(OI)(CI)M" `
  'BUILTIN\Administrators:(OI)(CI)F' 'NT AUTHORITY\SYSTEM:(OI)(CI)F' /T /Q | Out-Null
Write-Host 'Droits accordés.'

Write-Step 'Adresse publique'
$DefaultsPath = Join-Path $InstallDir 'agent.defaults.json'
$Defaults = Get-Content -Raw -Encoding UTF8 $DefaultsPath | ConvertFrom-Json
$Ui = [pscustomobject]@{ port = $Port; publicUrl = "https://$Domain" }
if ($Defaults.PSObject.Properties.Name -contains 'ui') { $Defaults.ui = $Ui } else { $Defaults | Add-Member -NotePropertyName ui -NotePropertyValue $Ui }
[System.IO.File]::WriteAllText($DefaultsPath, ($Defaults | ConvertTo-Json -Depth 20), [System.Text.UTF8Encoding]::new($false))
Write-Host "Site Agent répondra sur https://$Domain"

Write-Step "Tâche « $AgentTask »"
$AgentAction = New-ScheduledTaskAction -Execute 'cmd.exe' `
  -Argument "/c `"`"$Node`" src\cli.js serve >> logs\agent.log 2>&1`"" `
  -WorkingDirectory $InstallDir
Register-ScheduledTask -TaskName $AgentTask -Action $AgentAction -Trigger (New-ServiceTriggers) `
  -Settings (New-ServiceSettings) -User "${env:COMPUTERNAME}\$ServiceUser" -Password (Get-PlainText $Password) `
  -RunLevel Limited -Description 'Surveillance et mise à jour des sites' -Force | Out-Null
Write-Host 'Tâche créée : elle démarre avec le serveur, sous le compte dédié.'

Write-Step "Tâche « $CaddyTask » (HTTPS)"
$CaddyDir = Split-Path $CaddyPath
$Caddyfile = Join-Path $CaddyDir 'Caddyfile'
$CaddyConfig = @"
# Créé par Site Agent. Caddy obtient et renouvelle le certificat HTTPS tout seul.
$Domain {
	encode gzip
	reverse_proxy 127.0.0.1:$Port
}
"@
[System.IO.File]::WriteAllText($Caddyfile, $CaddyConfig, [System.Text.UTF8Encoding]::new($false))
$CaddyAction = New-ScheduledTaskAction -Execute $CaddyPath -Argument "run --config `"$Caddyfile`" --adapter caddyfile" -WorkingDirectory $CaddyDir
# Caddy a besoin des ports 80 et 443 : il tourne sous le compte système, l'agent non.
Register-ScheduledTask -TaskName $CaddyTask -Action $CaddyAction -Trigger (New-ServiceTriggers) `
  -Settings (New-ServiceSettings) -User 'NT AUTHORITY\SYSTEM' -RunLevel Highest `
  -Description 'HTTPS pour Site Agent' -Force | Out-Null
Write-Host "Caddy configuré dans $Caddyfile"

Write-Step 'Pare-feu : ports 80 et 443 uniquement'
foreach ($FirewallPort in 80, 443) {
  $RuleName = "Site Agent - HTTPS ($FirewallPort)"
  if (-not (Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName $RuleName -Direction Inbound -Protocol TCP -LocalPort $FirewallPort -Action Allow | Out-Null
  }
}
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

Write-Step 'Premier administrateur'
Push-Location $InstallDir
try { & $Node src\cli.js setup-link } finally { Pop-Location }

Write-Host ''
Write-Host 'Installation terminée.' -ForegroundColor Green
Write-Host "Ouvrez le lien ci-dessus depuis votre PC. Si le certificat n'est pas encore prêt, attendez une minute :"
Write-Host "Caddy l'obtient dès que le nom $Domain pointe vers ce serveur."
Write-Host 'Étape suivante : créer la clé de déploiement du compte de service (voir le guide, partie 7).'
