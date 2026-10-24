<#
 oe-run.ps1 - helper to run OpenEdge ABL programs for this repo on Windows (OpenEdge 12.8, DLC=C:\Progress\OpenEdge).
 Examples (from the repo root, in PowerShell):
   .\scripts\oe-run.ps1 -Action load-schema      # fresh db, server STOPPED: 002-farm-ops.df then 003-coop.df
   .\scripts\oe-run.ps1 -Action load-coop        # existing farm db that already has 002: load 003-coop.df only (server STOPPED)
   .\scripts\oe-run.ps1 -Action seed             # db server running on port 20000; loads seed.json and coop-seed.json
   .\scripts\oe-run.ps1 -Action test             # reseed, then every contract case (including CO01-CO76) in batch mode
   .\scripts\oe-run.ps1 -Action test-coop        # reseed, then only CO01-CO76 in batch mode
   .\scripts\oe-run.ps1 -Action test-http        # reseed, then every case over HTTP (PASOE must be running)
   .\scripts\oe-run.ps1 -Action test-http-coop   # reseed, then only CO01-CO76 over HTTP
#>
param(
  [ValidateSet('load-schema','load-coop','scratch-schema','seed','test','test-coop','test-http','test-http-coop','start-db','stop-db')][string]$Action = 'test',
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
  'start-db' { # -minport/-maxport keep the DB's server ports away from 3000, which the Node API uses
    Start-Process -FilePath (Join-Path $Dlc 'bin\proserve.bat') -ArgumentList 'farm','-S',"$Port",'-minport','3100','-maxport','3199' -WorkingDirectory $DbDir -WindowStyle Hidden }
  'scratch-schema' {
    # dry-run the .df files into a throw-away empty database (does not touch the real farm DB or stop the server)
    $sd = Join-Path (Split-Path -Parent $DbDir) 'scratch'; Remove-Item $sd -Recurse -Force -ErrorAction SilentlyContinue; New-Item -ItemType Directory $sd | Out-Null
    Push-Location $sd; & (Join-Path $Dlc 'bin\prodb.exe') scratch empty | Out-Null; Pop-Location
    foreach ($df in '001-farm.df','002-farm-ops.df','003-coop.df') { Invoke-Abl 'load-schema.p' (Join-Path $repo "openedge\schema\$df") @('-b','-db',(Join-Path $sd 'scratch'),'-1') }
  }
  'stop-db'  { & (Join-Path $Dlc 'bin\proshut.bat') (Join-Path $DbDir 'farm') -by }
  'load-schema' {
    foreach ($df in 'openedge\schema\002-farm-ops.df','openedge\schema\003-coop.df') {
      Invoke-Abl 'load-schema.p' (Join-Path $repo $df) @('-b','-db',(Join-Path $DbDir 'farm'),'-1')
    }
  }
  'load-coop' {
    Invoke-Abl 'load-schema.p' (Join-Path $repo 'openedge\schema\003-coop.df') @('-b','-db',(Join-Path $DbDir 'farm'),'-1')
  }
  'seed' { Invoke-Abl 'seed.p' ((Join-Path $repo 'openedge\data\seed.json') + '|' + (Join-Path $repo 'openedge\data\coop-seed.json')) $client }
  'test' {
    Invoke-Abl 'seed.p' ((Join-Path $repo 'openedge\data\seed.json') + '|' + (Join-Path $repo 'openedge\data\coop-seed.json')) $client
    $out = Join-Path $repo 'eval\abl-results.json'
    Invoke-Abl 'run-contract.p' ((Join-Path $repo 'eval\oe-contract-cases.json') + '|' + $out) $client
    & node (Join-Path $repo 'eval\compare-oe.mjs') $out
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  }
  'test-coop' {
    Invoke-Abl 'seed.p' ((Join-Path $repo 'openedge\data\seed.json') + '|' + (Join-Path $repo 'openedge\data\coop-seed.json')) $client
    $out = Join-Path $repo 'eval\abl-results.json'
    Invoke-Abl 'run-contract.p' ((Join-Path $repo 'eval\oe-contract-cases.json') + '|' + $out + '|CO') $client
    & node (Join-Path $repo 'eval\compare-oe.mjs') $out --coop
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  }
  'test-http' {
    Invoke-Abl 'seed.p' ((Join-Path $repo 'openedge\data\seed.json') + '|' + (Join-Path $repo 'openedge\data\coop-seed.json')) $client
    & node (Join-Path $repo 'eval\compare-oe.mjs') --http $(if ($env:OE_BASE_URL) { $env:OE_BASE_URL } else { 'http://localhost:8820/web' })
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  }
  'test-http-coop' {
    Invoke-Abl 'seed.p' ((Join-Path $repo 'openedge\data\seed.json') + '|' + (Join-Path $repo 'openedge\data\coop-seed.json')) $client
    & node (Join-Path $repo 'eval\compare-oe.mjs') --http $(if ($env:OE_BASE_URL) { $env:OE_BASE_URL } else { 'http://localhost:8820/web' }) --coop
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  }
}
