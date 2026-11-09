#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Arrête et retire le service Site Agent. Les données (comptes, sites, historique, sauvegardes) sont conservées.

.EXAMPLE
  .\deploy\windows\uninstall.ps1
  .\deploy\windows\uninstall.ps1 -RemoveServiceUser
#>
param(
  [string] $ServiceUser = 'site-agent',
  [switch] $RemoveServiceUser
)

$ErrorActionPreference = 'Stop'

foreach ($Task in 'Site Agent', 'Site Agent - Caddy') {
  if (Get-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $Task -Confirm:$false
    Write-Host "Tâche retirée : $Task"
  }
}

Get-NetFirewallRule -DisplayName 'Site Agent - HTTPS (*)' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
Write-Host 'Règles de pare-feu retirées.'

if ($RemoveServiceUser -and (Get-LocalUser -Name $ServiceUser -ErrorAction SilentlyContinue)) {
  Remove-LocalUser -Name $ServiceUser
  Write-Host "Compte retiré : $ServiceUser"
}

Write-Host ''
Write-Host 'Service retiré. Le dossier de Site Agent et ses données sont intacts.'
