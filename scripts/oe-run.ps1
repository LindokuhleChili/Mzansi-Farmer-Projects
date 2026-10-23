<#
 oe-run.ps1 - helper to run OpenEdge ABL programs for this repo on Windows (OpenEdge 12.8, DLC=C:\Progress\OpenEdge).
 Examples (from the repo root, in PowerShell):
   .\scripts\oe-run.ps1 -Action load-schema      # needs the db server STOPPED (single-user)
   .\scripts\oe-run.ps1 -Action seed             # db server running on port 20000
   .\scripts\oe-run.ps1 -Action test             # reseed, then run the contract cases against the real ABL rules
#>
param(
  [ValidateSet('load-schema','seed','test','start-db','stop-db')][string]$Action = 'test',
  [string]$Dlc = $(if ($env:DLC) { $env:DLC } else { 'C:\Progress\OpenEdge' }),
  [string]$DbDir = $(if ($env:FARM_DB_DIR) { $env:FARM_DB_DIR } else { 'C:\OpenEdge\WRK\farm' }),
  [int]$Port = 20000
)
$ErrorActionPreference = 'Stop'
$env:DLC = $Dlc
$repo = Split-Path -Parent $PSScriptRoot
$src = Join-Path $repo 'openedge\src'
$pro = Join-Path $Dlc 'bin\_progres.exe'
$client = @('-b','-db',(Join-Path $DbDir 'farm'),'-H','localhost','-S',"$Port")
function Invoke-Abl($prog, $param, $extra = @()) {
  Push-Location $src
  try { & $pro @extra -p $prog -param $param 2>&1 } finally { Pop-Location }
}
switch ($Action) {
  'start-db' { & (Join-Path $Dlc 'bin\proserve.bat') (Join-Path $DbDir 'farm') -S $Port }
  'stop-db'  { & (Join-Path $Dlc 'bin\proshut.bat') (Join-Path $DbDir 'farm') -by }
  'load-schema' {
    foreach ($df in 'openedge\schema\002-farm-ops.df') {
      Invoke-Abl 'load-schema.p' (Join-Path $repo $df) @('-b','-db',(Join-Path $DbDir 'farm'),'-1')
    }
  }
  'seed' { Invoke-Abl 'seed.p' (Join-Path $repo 'openedge\data\seed.json') $client }
  'test' {
    Invoke-Abl 'seed.p' (Join-Path $repo 'openedge\data\seed.json') $client
    $out = Join-Path $repo 'eval\abl-results.json'
    Invoke-Abl 'run-contract.p' ((Join-Path $repo 'eval\oe-contract-cases.json') + '|' + $out) $client
    & node (Join-Path $repo 'eval\compare-oe.mjs') $out
  }
}
