# Platform bootstrap installer (Windows). Best-effort for v1.
#
# Usage: irm https://platform.example.com/install.ps1 | iex
#
# Equivalent steps to install.sh (mise via Scoop, Node 22 + pnpm,
# Docker Desktop via winget, Claude Code, platform CLI). Windows is
# tagged "best-effort" until we have someone to maintain it as a
# first-class platform.

$ErrorActionPreference = "Stop"

# PLATFORM_PROXY_BASE_URL is templated in by the install route at serve
# time (the script you got via `irm https://<host>/install.ps1` already
# has __PLATFORM_PROXY_BASE_URL__ replaced with that <host>). Explicit
# env var still wins — useful for contributors testing against a
# different environment.
$ProxyBaseUrl = if ($env:PLATFORM_PROXY_BASE_URL) { $env:PLATFORM_PROXY_BASE_URL } else { "__PLATFORM_PROXY_BASE_URL__" }
# Build the placeholder sentinel by concatenation so the install route's
# replaceAll doesn't substitute it here too. Without this the templated
# copy compares the templated default against itself and always exits.
$Placeholder = "__PLATFORM_" + "PROXY_BASE_URL" + "__"
if ($ProxyBaseUrl -eq $Placeholder) {
  Write-Error "This install.ps1 appears to be the raw repo copy (no templated host). Either run it from a deployed platform host (irm https://<host>/install.ps1) or set `$env:PLATFORM_PROXY_BASE_URL before running."
  exit 1
}
$PlatformHome = Join-Path $env:USERPROFILE ".platform"
$PlatformBin  = Join-Path $PlatformHome "bin"
$NodeVersion  = "22"
$PnpmVersion  = "10.30.3"

function Say  ($msg) { Write-Host "▸ $msg" -ForegroundColor Cyan }
function Ok   ($msg) { Write-Host "✓ $msg" -ForegroundColor Green }
function Warn ($msg) { Write-Host "! $msg" -ForegroundColor Yellow }
function Bail ($msg) { Write-Host "✗ $msg" -ForegroundColor Red; exit 1 }

New-Item -ItemType Directory -Force -Path $PlatformBin | Out-Null

# 1. mise via Scoop ---------------------------------------------------
if (-not (Get-Command mise -ErrorAction SilentlyContinue)) {
  Say "Installing mise…"
  if (-not (Get-Command scoop -ErrorAction SilentlyContinue)) {
    Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned -Force
    Invoke-RestMethod -Uri https://get.scoop.sh | Invoke-Expression
  }
  scoop install mise
  Ok "Installed mise"
} else {
  Ok "mise already installed"
}

# 2. Node + pnpm via mise --------------------------------------------
Say "Pinning Node $NodeVersion and pnpm $PnpmVersion…"
$miseConfig = Join-Path $env:USERPROFILE ".config\platform\mise.toml"
New-Item -ItemType Directory -Force -Path (Split-Path $miseConfig -Parent) | Out-Null
@"
[tools]
node = "$NodeVersion"
pnpm = "$PnpmVersion"
"@ | Set-Content -Encoding UTF8 -Path $miseConfig
mise install -q

# 3. Docker Desktop via winget ---------------------------------------
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Say "Installing Docker Desktop…"
  try {
    winget install -e --id Docker.DockerDesktop --silent --accept-package-agreements --accept-source-agreements
    Ok "Docker Desktop installed (you may need to launch it once and accept the EULA)"
  } catch {
    Warn "winget install Docker.DockerDesktop failed; install manually from https://docker.com/desktop"
  }
} else {
  Ok "Docker already installed"
}

# 4. Claude Code (assumed pre-installed) -----------------------------
# The platform expects Claude Code to already be on PATH. We don't
# auto-install it. Warn if missing so the dev knows to install it.
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
  Warn "Claude Code is not on PATH — install it from https://claude.ai/install before running 'platform login'."
} else {
  Ok "Claude Code on PATH"
}

# 5. Platform CLI ----------------------------------------------------
Say "Installing the platform CLI…"
# Pull the CLI tarball from the public release. ProxyBaseUrl above is
# the per-platform proxy host (used for git/npm + login) — separate
# concern from where the binary lives. The binary is the same artifact
# for every consumer platform, so it ships from one public release.
$ReleaseBase = if ($env:PLATFORM_CLI_RELEASE_BASE) { $env:PLATFORM_CLI_RELEASE_BASE } else { "https://github.com/EyanGoldman/platform-cli/releases/latest/download" }
$tarballUrl = "$ReleaseBase/platform-cli-latest.tgz"
$credHelperUrl = "$ReleaseBase/platform-cred-helper.tgz"
$tmp = New-Item -ItemType Directory -Force -Path (Join-Path $env:TEMP ("platform-cli-" + (Get-Random)))
try {
  $tarPath = Join-Path $tmp "platform-cli.tgz"
  Invoke-WebRequest -Uri $tarballUrl -OutFile $tarPath -UseBasicParsing
  tar -xzf $tarPath -C $tmp
  $pkg = Join-Path $tmp "package"
  if (Test-Path $pkg) {
    $cliDir = Join-Path $PlatformHome "cli"
    if (Test-Path $cliDir) { Remove-Item $cliDir -Recurse -Force }
    Move-Item $pkg $cliDir
    # Windows can't symlink without admin; emit a tiny .cmd shim.
    @"
@echo off
node "%USERPROFILE%\.platform\cli\dist\index.js" %*
"@ | Set-Content -Path (Join-Path $PlatformBin "platform.cmd")
    Ok "Platform CLI installed"
  } else {
    Warn "Tarball missing 'package' directory"
  }

  # Cred-helper ships as its own tarball.
  $helperTarPath = Join-Path $tmp "platform-cred-helper.tgz"
  Invoke-WebRequest -Uri $credHelperUrl -OutFile $helperTarPath -UseBasicParsing
  $helperDir = Join-Path $PlatformHome "cred-helper"
  if (Test-Path $helperDir) { Remove-Item $helperDir -Recurse -Force }
  New-Item -ItemType Directory -Path $helperDir -Force | Out-Null
  tar -xzf $helperTarPath -C $helperDir
  @"
@echo off
node "%USERPROFILE%\.platform\cred-helper\platform-cred-helper.mjs" %*
"@ | Set-Content -Path (Join-Path $PlatformBin "platform-cred-helper.cmd")
  Ok "Credential helper installed"
} catch {
  Warn "Could not download $tarballUrl (release tarball not yet published)."
  Warn "Dev-mode fallback: clone github.com/EyanGoldman/platform-cli and build locally."
} finally {
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

# 6. PATH wiring -----------------------------------------------------
$existingPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($existingPath -notlike "*$PlatformBin*") {
  [Environment]::SetEnvironmentVariable("Path", "$PlatformBin;$existingPath", "User")
  Ok "Added $PlatformBin to user PATH"
}

# 7. Cred-helper config ----------------------------------------------
$proxyHost = ([Uri]$ProxyBaseUrl).Host
@"
{
  "proxyHost": "$proxyHost",
  "proxyBaseUrl": "$ProxyBaseUrl"
}
"@ | Set-Content -Encoding UTF8 -Path (Join-Path $PlatformHome "cred-helper.json")

# 8. Run platform login ----------------------------------------------
Say ""
Say "Almost done — sign in via your browser to mint a token."
$env:PLATFORM_PROXY_BASE_URL = $ProxyBaseUrl
$env:Path = "$PlatformBin;$env:Path"
& platform login
if ($LASTEXITCODE -ne 0) {
  Bail "platform login failed; re-run when you're ready."
}

Ok "All set. Open Claude Code and tell it what to build."
