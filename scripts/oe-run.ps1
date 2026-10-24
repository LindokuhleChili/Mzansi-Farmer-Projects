<#
 oe-run.ps1 - helper to run OpenEdge ABL programs for this repo on Windows (OpenEdge 12.8, DLC=C:\Progress\OpenEdge).
 Examples (from the repo root, in PowerShell):
   .\scripts\oe-run.ps1 -Action load-schema      # fresh db, server STOPPED: 002-farm-ops.df, 003-coop.df then 004-market.df
   .\scripts\oe-run.ps1 -Action load-coop        # existing farm db that already has 002: load 003-coop.df only (server STOPPED)
   .\scripts\oe-run.ps1 -Action load-market      # existing farm db that already has 003: load 004-market.df only (server STOPPED)
   .\scripts\oe-run.ps1 -Action seed             # db server running on port 20000; loads seed.json, coop-seed.json and market-seed.json
   .\scripts\oe-run.ps1 -Action test             # reseed, then every contract case (including CO01-CO76) in batch mode
   .\scripts\oe-run.ps1 -Action test-coop        # reseed, then only CO01-CO76 in batch mode
   .\scripts\oe-run.ps1 -Action test-http        # reseed, then every case over HTTP (PASOE must be running)
   .\scripts\oe-run.ps1 -Action test-http-coop   # reseed, then only CO01-CO76 over HTTP
   .\scripts\oe-run.ps1 -Action test-market      # reseed, then only the market cases MK01-MK51 in batch mode
   .\scripts\oe-run.ps1 -Action test-http-market # reseed, then only MK01-MK51 over HTTP
   .\scripts\oe-run.ps1 -Action scratch-test     # throw-away database next to the farm db: load 001-004, seed, run EVERY case single-user.
                                                  # Never touches the farm database or PASOE; safe while they run.
#>
param(
  [ValidateSet('load-schema','load-coop','load-market','scratch-schema','scratch-test','seed','test','test-coop','test-market','test-http','test-http-coop','test-http-market','start-db','stop-db')][string]$Action = 'test',
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
$seedFiles = (Join-Path $repo 'openedge\data\seed.json') + '|' + (Join-Path $repo 'openedge\data\coop-seed.json') + '|' + (Join-Path $repo 'openedge\data\market-seed.json')
$scratchDir = Join-Path (Split-Path -Parent $DbDir) 'scratch'
# load_df.p writes <db>.e next to the program when a .df fails; the DONE message alone does not prove success
function Assert-SchemaLoaded($dbName) {
  $e = Join-Path $src "$dbName.e"
  if (Test-Path $e) { Get-Content $e; throw "Schema load failed, see $e" }
}
function New-ScratchDb {
  Remove-Item $scratchDir -Recurse -Force -ErrorAction SilentlyContinue; New-Item -ItemType Directory $scratchDir | Out-Null
  Push-Location $scratchDir; & (Join-Path $Dlc 'bin\prodb.exe') scratch empty | Out-Null; Pop-Location
  Remove-Item (Join-Path $src 'scratch.e') -ErrorAction SilentlyContinue
  foreach ($df in '001-farm.df','002-farm-ops.df','003-coop.df','004-market.df') {
    Invoke-Abl 'load-schema.p' (Join-Path $repo "openedge\schema\$df") @('-b','-db',(Join-Path $scratchDir 'scratch'),'-1')
    Assert-SchemaLoaded 'scratch'
  }
}
switch ($Action) {
  'start-db' { # -minport/-maxport keep the DB's server ports away from 3000, which the Node API uses
    Start-Process -FilePath (Join-Path $Dlc 'bin\proserve.bat') -ArgumentList 'farm','-S',"$Port",'-minport','3100','-maxport','3199' -WorkingDirectory $DbDir -WindowStyle Hidden }
  'scratch-schema' {
    # dry-run the .df files into a throw-away empty database (does not touch the real farm DB or stop the server)
    New-ScratchDb
    Write-Output "SCRATCH SCHEMA OK: 001-004 loaded into $scratchDir\scratch"
  }
  'scratch-test' {
    # the full contract (irrigation, co-op, market) on real ABL against a throw-away single-user database
    New-ScratchDb
    $sc = @('-b','-db',(Join-Path $scratchDir 'scratch'),'-1')
    Invoke-Abl 'seed.p' $seedFiles $sc
    $out = Join-Path $repo 'eval\abl-results.json'
    Invoke-Abl 'run-contract.p' ((Join-Path $repo 'eval\oe-contract-cases.json') + '|' + $out) $sc
    & node (Join-Path $repo 'eval\compare-oe.mjs') $out
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  }
  'stop-db'  { & (Join-Path $Dlc 'bin\proshut.bat') (Join-Path $DbDir 'farm') -by }
  'load-schema' {
    foreach ($df in 'openedge\schema\002-farm-ops.df','openedge\schema\003-coop.df','openedge\schema\004-market.df') {
      Invoke-Abl 'load-schema.p' (Join-Path $repo $df) @('-b','-db',(Join-Path $DbDir 'farm'),'-1')
      Assert-SchemaLoaded 'farm'
    }
  }
  'load-coop' {
    Invoke-Abl 'load-schema.p' (Join-Path $repo 'openedge\schema\003-coop.df') @('-b','-db',(Join-Path $DbDir 'farm'),'-1')
    Assert-SchemaLoaded 'farm'
  }
  'load-market' {
    Remove-Item (Join-Path $src 'farm.e') -ErrorAction SilentlyContinue
    Invoke-Abl 'load-schema.p' (Join-Path $repo 'openedge\schema\004-market.df') @('-b','-db',(Join-Path $DbDir 'farm'),'-1')
    Assert-SchemaLoaded 'farm'
  }
  'seed' { Invoke-Abl 'seed.p' $seedFiles $client }
  'test' {
    Invoke-Abl 'seed.p' $seedFiles $client
    $out = Join-Path $repo 'eval\abl-results.json'
    Invoke-Abl 'run-contract.p' ((Join-Path $repo 'eval\oe-contract-cases.json') + '|' + $out) $client
    & node (Join-Path $repo 'eval\compare-oe.mjs') $out
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  }
  'test-coop' {
    Invoke-Abl 'seed.p' $seedFiles $client
    $out = Join-Path $repo 'eval\abl-results.json'
    Invoke-Abl 'run-contract.p' ((Join-Path $repo 'eval\oe-contract-cases.json') + '|' + $out + '|CO') $client
    & node (Join-Path $repo 'eval\compare-oe.mjs') $out --coop
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  }
  'test-http' {
    Invoke-Abl 'seed.p' $seedFiles $client
    & node (Join-Path $repo 'eval\compare-oe.mjs') --http $(if ($env:OE_BASE_URL) { $env:OE_BASE_URL } else { 'http://localhost:8820/web' })
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  }
  'test-market' {
    Invoke-Abl 'seed.p' $seedFiles $client
    $out = Join-Path $repo 'eval\abl-results.json'
    Invoke-Abl 'run-contract.p' ((Join-Path $repo 'eval\oe-contract-cases.json') + '|' + $out + '|MK') $client
    & node (Join-Path $repo 'eval\compare-oe.mjs') $out --market
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  }
  'test-http-market' {
    Invoke-Abl 'seed.p' $seedFiles $client
    & node (Join-Path $repo 'eval\compare-oe.mjs') --http $(if ($env:OE_BASE_URL) { $env:OE_BASE_URL } else { 'http://localhost:8820/web' }) --market
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  }
  'test-http-coop' {
    Invoke-Abl 'seed.p' $seedFiles $client
    & node (Join-Path $repo 'eval\compare-oe.mjs') --http $(if ($env:OE_BASE_URL) { $env:OE_BASE_URL } else { 'http://localhost:8820/web' }) --coop
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  }
}
