<#
 oe-run.ps1 - helper to run OpenEdge ABL programs for this repo on Windows (OpenEdge 12.8, DLC=C:\Progress\OpenEdge).
 Examples (from the repo root, in PowerShell):
   .\scripts\oe-run.ps1 -Action load-schema      # fresh db, server STOPPED: 002-farm-ops.df, 003-coop.df then 004-market.df
   .\scripts\oe-run.ps1 -Action load-coop        # existing farm db that already has 002: load 003-coop.df only (server STOPPED)
   .\scripts\oe-run.ps1 -Action load-market      # existing farm db that already has 003: load 004-market.df only (server STOPPED)
.\scripts\oe-run.ps1 -Action load-audit-chain # existing farm db that already has 004: load 005-audit-chain.df only (server STOPPED)
.\scripts\oe-run.ps1 -Action load-weather      # existing farm db that already has 004: load 006-weather.df only (server STOPPED), then seed
.\scripts\oe-run.ps1 -Action load-doctor       # existing farm db that already has 006: load 007-doctor.df only (server STOPPED), then seed
.\scripts\oe-run.ps1 -Action load-assistant    # existing farm db that already has 007: load 008-assistant.df only (server STOPPED), then seed
   .\scripts\oe-run.ps1 -Action seed             # db server running on port 20000; loads seed.json, coop-seed.json and market-seed.json
   .\scripts\oe-run.ps1 -Action test             # reseed, then every contract case (including CO01-CO76) in batch mode
   .\scripts\oe-run.ps1 -Action test-coop        # reseed, then only CO01-CO76 in batch mode
   .\scripts\oe-run.ps1 -Action test-http        # reseed, then every case over HTTP (PASOE must be running)
   .\scripts\oe-run.ps1 -Action test-http-coop   # reseed, then only CO01-CO76 over HTTP
   .\scripts\oe-run.ps1 -Action test-market      # reseed, then only the market cases MK01-MK51 in batch mode
   .\scripts\oe-run.ps1 -Action test-http-market # reseed, then only MK01-MK51 over HTTP
   .\scripts\oe-run.ps1 -Action test-security    # PASOE basic login: 401 / 403 / admin-role checks (eval/pasoe-security.mjs), then reseed
   HTTP actions read OE_AUTH, OE_ADMIN_AUTH and OE_NONE_AUTH from the environment, else from the repo .env
   (or the file in FARM_ENV_FILE). The values are never printed.
   .\scripts\oe-run.ps1 -Action scratch-test     # throw-away database next to the farm db: load 001-004, seed, run EVERY case single-user.
                                                  # Never touches the farm database or PASOE; safe while they run.
#>
param(
  [ValidateSet('load-schema','load-coop','load-market','load-audit-chain','load-weather','load-doctor','load-assistant','scratch-schema','scratch-test','seed','test','test-coop','test-market','test-http','test-http-coop','test-http-market','test-security','start-db','stop-db')][string]$Action = 'test',
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
$seedFiles = (Join-Path $repo 'openedge\data\seed.json') + '|' + (Join-Path $repo 'openedge\data\coop-seed.json') + '|' + (Join-Path $repo 'openedge\data\market-seed.json') + '|' + (Join-Path $repo 'openedge\data\weather-seed.json') + '|' + (Join-Path $repo 'openedge\data\doctor-seed.json') + '|' + (Join-Path $repo 'openedge\data\guide-seed.json')
$scratchDir = Join-Path (Split-Path -Parent $DbDir) 'scratch'
# PASOE basic-login credentials for the HTTP actions: real environment first, then .env (never printed)
$envFile = if ($env:FARM_ENV_FILE) { $env:FARM_ENV_FILE } else { Join-Path $repo '.env' }
if (Test-Path $envFile) {
  foreach ($line in Get-Content $envFile) {
    if ($line -match '^\s*(OE_AUTH|OE_ADMIN_AUTH|OE_NONE_AUTH)\s*=\s*(.+?)\s*$' -and -not [Environment]::GetEnvironmentVariable($Matches[1])) {
      [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process')
    }
  }
}
# load_df.p writes <db>.e next to the program when a .df fails; the DONE message alone does not prove success
function Assert-SchemaLoaded($dbName) {
  $e = Join-Path $src "$dbName.e"
  if (Test-Path $e) { Get-Content $e; throw "Schema load failed, see $e" }
}
function New-ScratchDb {
  Remove-Item $scratchDir -Recurse -Force -ErrorAction SilentlyContinue; New-Item -ItemType Directory $scratchDir | Out-Null
  Push-Location $scratchDir; & (Join-Path $Dlc 'bin\prodb.exe') scratch empty | Out-Null; Pop-Location
  Remove-Item (Join-Path $src 'scratch.e') -ErrorAction SilentlyContinue
  foreach ($df in '001-farm.df','002-farm-ops.df','003-coop.df','004-market.df','005-audit-chain.df','006-weather.df','007-doctor.df','008-assistant.df') {
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
    # audit hash chain on real ABL: parity with Node, verify, tamper detection (edits a row, so scratch only)
    $t = Invoke-Abl 'audit-tamper-test.p' 'scratch' $sc
    $t
    if (-not ($t -match 'AUDIT TAMPER TEST DONE: 0 failed')) { exit 1 }
  }
  'stop-db'  { & (Join-Path $Dlc 'bin\proshut.bat') (Join-Path $DbDir 'farm') -by }
  'load-schema' {
    foreach ($df in 'openedge\schema\002-farm-ops.df','openedge\schema\003-coop.df','openedge\schema\004-market.df','openedge\schema\005-audit-chain.df','openedge\schema\006-weather.df','openedge\schema\007-doctor.df','openedge\schema\008-assistant.df') {
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
  'load-audit-chain' {
    Remove-Item (Join-Path $src 'farm.e') -ErrorAction SilentlyContinue
    Invoke-Abl 'load-schema.p' (Join-Path $repo 'openedge\schema\005-audit-chain.df') @('-b','-db',(Join-Path $DbDir 'farm'),'-1')
    Assert-SchemaLoaded 'farm'
  }
  'load-weather' {
    Remove-Item (Join-Path $src 'farm.e') -ErrorAction SilentlyContinue
    Invoke-Abl 'load-schema.p' (Join-Path $repo 'openedge\schema\006-weather.df') @('-b','-db',(Join-Path $DbDir 'farm'),'-1')
    Assert-SchemaLoaded 'farm'
  }
  'load-doctor' {
    Remove-Item (Join-Path $src 'farm.e') -ErrorAction SilentlyContinue
    Invoke-Abl 'load-schema.p' (Join-Path $repo 'openedge\schema\007-doctor.df') @('-b','-db',(Join-Path $DbDir 'farm'),'-1')
    Assert-SchemaLoaded 'farm'
  }
  'load-assistant' {
    Remove-Item (Join-Path $src 'farm.e') -ErrorAction SilentlyContinue
    Invoke-Abl 'load-schema.p' (Join-Path $repo 'openedge\schema\008-assistant.df') @('-b','-db',(Join-Path $DbDir 'farm'),'-1')
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
  'test-security' {
    & node (Join-Path $repo 'eval\pasoe-security.mjs') $(if ($env:OE_BASE_URL) { $env:OE_BASE_URL } else { 'http://localhost:8820/web' })
    $code = $LASTEXITCODE
    Invoke-Abl 'seed.p' $seedFiles $client | Out-Null   # SEC07 added a blocked term; put the seed data back
    if ($code -ne 0) { exit $code }
  }
  'test-http-coop' {
    Invoke-Abl 'seed.p' $seedFiles $client
    & node (Join-Path $repo 'eval\compare-oe.mjs') --http $(if ($env:OE_BASE_URL) { $env:OE_BASE_URL } else { 'http://localhost:8820/web' }) --coop
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  }
}
