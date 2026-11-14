# Native Windows install/update; no administrator needed. Two methods:
#
#   irm https://raw.githubusercontent.com/Steven-ODell/tercet/main/install.ps1 | iex
#       downloads the prebuilt tercet.exe (no Bun needed), checks it against the release's
#       SHA256SUMS and puts it in %LOCALAPPDATA%\Programs\tercet, which it adds to your user PATH
#   .\install.ps1 -Method bun
#       installs with Bun instead (Bun 1.4.0 or newer must already be on PATH)
#
#   -Version vX.Y.Z   a release other than the newest         ($env:TERCET_VERSION)
#   -Dir DIR          where tercet.exe goes                   ($env:TERCET_INSTALL_DIR)
#   -Source SPEC      Bun method only: another spec, e.g. github:Steven-ODell/tercet#v0.1.0
#                     ($env:TERCET_SOURCE); giving one selects the Bun method
param(
    [ValidateSet('binary', 'bun')][string]$Method = $(if ($env:TERCET_METHOD) { $env:TERCET_METHOD } else { 'binary' }),
    [string]$Version = $env:TERCET_VERSION,
    [string]$Dir = $(if ($env:TERCET_INSTALL_DIR) { $env:TERCET_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\tercet' }),
    [string]$Source = $env:TERCET_SOURCE
)
$ErrorActionPreference = 'Stop'
$repo = 'Steven-ODell/tercet'
if ($Source) { $Method = 'bun' }

if ($Method -eq 'binary') {
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
    if ($arch -ne 'x64') { throw "No prebuilt Windows binary for $arch yet. Use -Method bun, or see docs/install.md." }
    $name = "tercet-windows-$arch.exe"
    $base = if ($env:TERCET_BASE_URL) { $env:TERCET_BASE_URL } else { "https://github.com/$repo/releases" }
    if ($Version) {
        if (-not $Version.StartsWith('v')) { $Version = "v$Version" }
        $url = "$base/download/$Version"
    } else {
        $url = "$base/latest/download"
    }
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ("tercet-install-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force $tmp | Out-Null
    try {
        Write-Host "Downloading $name from $url"
        try {
            Invoke-WebRequest "$url/$name" -OutFile (Join-Path $tmp $name) -UseBasicParsing
            Invoke-WebRequest "$url/SHA256SUMS" -OutFile (Join-Path $tmp 'SHA256SUMS') -UseBasicParsing
        } catch {
            throw "Could not download the release files ($($_.Exception.Message)). There may be no release yet; use -Method bun, or see docs/install.md."
        }
        $line = Get-Content (Join-Path $tmp 'SHA256SUMS') | Where-Object { $_ -match "^([0-9a-fA-F]{64})\s+\*?$([regex]::Escape($name))\s*$" } | Select-Object -First 1
        if (-not $line) { throw "SHA256SUMS has no line for $name." }
        $want = ($line -split '\s+')[0].ToLower()
        $got = (Get-FileHash (Join-Path $tmp $name) -Algorithm SHA256).Hash.ToLower()
        if ($got -ne $want) { throw "Checksum mismatch for $name (expected $want, got $got); nothing was installed." }
        New-Item -ItemType Directory -Force $Dir | Out-Null
        $target = Join-Path $Dir 'tercet.exe'
        # A running tercet.exe cannot be overwritten but can be renamed out of the way.
        if (Test-Path -LiteralPath $target) {
            $old = "$target.old"
            Remove-Item -LiteralPath $old -Force -ErrorAction SilentlyContinue
            Move-Item -LiteralPath $target -Destination $old -Force
        }
        Move-Item -LiteralPath (Join-Path $tmp $name) -Destination $target -Force
        Remove-Item -LiteralPath "$target.old" -Force -ErrorAction SilentlyContinue
    } finally {
        Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
    & $target --version
    if ($LASTEXITCODE -ne 0) { throw 'The installed tercet could not start.' }
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not (($userPath -split ';') -contains $Dir)) {
        [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ';' + $Dir), 'User')
        Write-Host "Added $Dir to your user PATH. Open a new terminal to use `tercet`."
    }
    Write-Host 'Next: tercet doctor checks your setup; tercet starts the client. Update later with tercet upgrade.'
    return
}

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    throw 'tercet needs Bun 1.4.0 or newer on PATH for this method. Install Bun from https://bun.com/docs/installation, open a new terminal, then retry (or drop -Method bun to install the binary).'
}
if (-not $Source) {
    if ($Version) {
        if (-not $Version.StartsWith('v')) { $Version = "v$Version" }
        $Source = "github:$repo#$Version"
    } else {
        $commit = (Invoke-RestMethod "https://api.github.com/repos/$repo/commits/main").sha
        if ($commit -notmatch '^[0-9a-f]{40}$') { throw 'Could not resolve the current tercet commit.' }
        $Source = "github:$repo#$commit"
    }
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
