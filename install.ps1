# Native Windows install/update. Bun must already be installed; no administrator is needed.
param([string]$Source = $env:TERCET_SOURCE)
$ErrorActionPreference = 'Stop'
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    throw 'tercet needs Bun 1.4.0 or newer on PATH. Install Bun from https://bun.com/docs/installation, open a new terminal, then retry.'
}
if (-not $Source) {
    $commit = (Invoke-RestMethod 'https://api.github.com/repos/Steven-ODell/tercet/commits/main').sha
    if ($commit -notmatch '^[0-9a-f]{40}$') { throw 'Could not resolve the current tercet commit.' }
    $Source = "github:Steven-ODell/tercet#$commit"
}
& bun install -g $Source
if ($LASTEXITCODE -ne 0) { throw "bun install failed (exit $LASTEXITCODE)." }
$binDir = (& bun pm bin -g | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Could not find Bun global bin directory.' }
$launcher = Join-Path $binDir 'tercet.exe'
if (-not (Test-Path -LiteralPath $launcher)) {
    $launcher = Join-Path $binDir 'tercet'
}
if (-not (Test-Path -LiteralPath $launcher)) { throw "No tercet launcher found in $binDir." }
& $launcher --version
if ($LASTEXITCODE -ne 0) { throw 'The installed tercet could not start.' }
if (-not (Get-Command tercet -ErrorAction SilentlyContinue)) {
    Write-Host "Add $binDir to your user PATH, then open a new terminal."
}
Write-Host 'Next: tercet doctor checks your setup; tercet starts the client.'
