#!/usr/bin/env bash
# Platform bootstrap installer (macOS / Linux).
#
# Usage:  curl -fsSL https://platform.example.com/install.sh | sh
#
# This script gets a brand-new dev machine from "nothing installed" to
# "ready to build apps via Claude Code." The user is non-technical
# (Excel-fluent, not architecture-fluent), so each step prints a plain
# sentence. Failures bail loudly with a single actionable line.
#
# What gets installed:
#   - mise            (runtime version manager)
#   - Node 22         (via mise)
#   - pnpm 10.30.3    (via mise)
#   - Docker          (OrbStack on macOS, docker.io on apt-based Linux)
#   - Claude Code     (official curl installer)
#   - platform CLI    (~/.platform/bin/platform)
#   - cred helper     (~/.platform/bin/platform-cred-helper)
#
# After install, runs `platform login` to mint a token and pre-register
# the marketplace.
#
# Idempotent: re-running just patches whatever's missing.

set -euo pipefail

# PLATFORM_PROXY_BASE_URL is templated in by the install route at serve
# time (the installed script you got via `curl https://<host>/install.sh`
# already has __PLATFORM_PROXY_BASE_URL__ replaced with that <host>).
# An explicit env var still overrides — useful for contributors testing
# against a different environment.
PLATFORM_PROXY_BASE_URL=${PLATFORM_PROXY_BASE_URL:-__PLATFORM_PROXY_BASE_URL__}
APP_STORE_URL=${APP_STORE_URL:-__APP_STORE_URL__}
API_GATEWAY_URL=${API_GATEWAY_URL:-__API_GATEWAY_URL__}
# Build the placeholder sentinels by concatenation so the install route's
# `replaceAll(__PLATFORM_PROXY_BASE_URL__, …)` (and siblings) don't
# substitute them here too. Without this the templated copy of the
# script would compare the templated default against itself and always
# exit 1.
__PROXY_PLACEHOLDER='__PLATFORM_'"PROXY_BASE_URL"'__'
__APP_STORE_PLACEHOLDER='__APP_'"STORE_URL"'__'
__API_GATEWAY_PLACEHOLDER='__API_'"GATEWAY_URL"'__'
if [ "${PLATFORM_PROXY_BASE_URL}" = "${__PROXY_PLACEHOLDER}" ] \
  || [ "${APP_STORE_URL}" = "${__APP_STORE_PLACEHOLDER}" ] \
  || [ "${API_GATEWAY_URL}" = "${__API_GATEWAY_PLACEHOLDER}" ]; then
  echo "Error: this install.sh appears to be the raw repo copy (no templated hosts)." >&2
  echo "Either run it from a deployed platform host (curl https://<host>/install.sh)," >&2
  echo "or set PLATFORM_PROXY_BASE_URL, APP_STORE_URL, and API_GATEWAY_URL before running." >&2
  exit 1
fi
PLATFORM_HOME="${HOME}/.platform"
PLATFORM_BIN="${PLATFORM_HOME}/bin"
NODE_VERSION="22"
PNPM_VERSION="10.30.3"

say() { printf '\033[1;36m▸\033[0m %s\n' "$*"; }
ok()  { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn(){ printf '\033[1;33m!\033[0m %s\n' "$*" >&2; }
err() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

uname_s=$(uname -s)
case "${uname_s}" in
  Darwin) OS="macos" ;;
  Linux)  OS="linux" ;;
  *) err "Unsupported OS: ${uname_s}. Run install.ps1 for Windows." ;;
esac

mkdir -p "${PLATFORM_BIN}"

# 1. mise -------------------------------------------------------------
if ! command -v mise >/dev/null 2>&1; then
  say "Installing mise (runtime version manager)…"
  curl -fsSL https://mise.run | sh
  # mise installs to ~/.local/bin; add to PATH for this script run.
  export PATH="${HOME}/.local/bin:${PATH}"
  ok "Installed mise"
else
  ok "mise already installed"
fi

# 2. Node + pnpm via mise --------------------------------------------
say "Pinning Node ${NODE_VERSION} and pnpm ${PNPM_VERSION}…"
mkdir -p "${HOME}/.config/platform"
cat > "${HOME}/.config/platform/mise.toml" <<EOF
[tools]
node = "${NODE_VERSION}"
pnpm = "${PNPM_VERSION}"
EOF
mise install -q || warn "mise install reported a problem; check 'mise list'"
ok "Node + pnpm pinned"

# 3. Docker -----------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  say "Installing Docker…"
  if [ "$OS" = "macos" ]; then
    if command -v brew >/dev/null 2>&1; then
      brew install --cask orbstack || warn "OrbStack install failed; install manually from https://orbstack.dev"
    else
      warn "Homebrew not found. Install OrbStack manually from https://orbstack.dev"
    fi
  else
    if command -v apt-get >/dev/null 2>&1; then
      sudo apt-get update -y
      sudo apt-get install -y docker.io || warn "apt install docker.io failed; install Docker manually."
    elif command -v dnf >/dev/null 2>&1; then
      sudo dnf install -y docker || warn "dnf install docker failed; install Docker manually."
    else
      warn "No supported package manager. Install Docker manually from https://docs.docker.com/engine/install/"
    fi
  fi
else
  ok "Docker already installed"
fi

# 4. Claude Code (assumed pre-installed) ------------------------------
# The platform expects Claude Code to already be on PATH. We don't
# auto-install it — that's a deliberate decision: this platform's
# devs work in Claude Code in their terminal as a baseline. We just
# warn if it's missing so the dev knows to install it themselves
# before continuing.
if ! command -v claude >/dev/null 2>&1; then
  warn "Claude Code is not on PATH — install it from https://claude.ai/install before running 'platform login'."
else
  ok "Claude Code on PATH"
fi

# 5. Platform CLI -----------------------------------------------------
say "Installing the platform CLI…"
# Pull the CLI tarball from the public release. PLATFORM_PROXY_BASE_URL
# above is the per-platform proxy host (used for git/npm + login below)
# — different concern from where the binary lives. The binary is the
# same artifact for every consumer platform, so it ships from a single
# public release.
TARBALL_URL="${PLATFORM_CLI_RELEASE_BASE:-https://github.com/EyanGoldman/platform-cli/releases/latest/download}/platform-cli-latest.tgz"
TMP=$(mktemp -d)
cleanup() { rm -rf "${TMP}"; }
trap cleanup EXIT

CRED_HELPER_URL="${PLATFORM_CLI_RELEASE_BASE:-https://github.com/EyanGoldman/platform-cli/releases/latest/download}/platform-cred-helper.tgz"

if curl -fsSL --output "${TMP}/platform-cli.tgz" "${TARBALL_URL}" 2>/dev/null; then
  tar -xzf "${TMP}/platform-cli.tgz" -C "${TMP}"
  # The tarball is expected to contain a `package` directory (npm
  # convention) with the CLI source in `dist/index.js`.
  if [ -d "${TMP}/package" ]; then
    rm -rf "${PLATFORM_HOME}/cli"
    mv "${TMP}/package" "${PLATFORM_HOME}/cli"
    ln -sfn "${PLATFORM_HOME}/cli/dist/index.js" "${PLATFORM_BIN}/platform"
    chmod +x "${PLATFORM_BIN}/platform" 2>/dev/null || true
    ok "Platform CLI installed at ${PLATFORM_BIN}/platform"
  else
    warn "Tarball missing 'package' directory; falling back to dev-mode install."
    DEV_MODE=1
  fi
else
  warn "Could not download ${TARBALL_URL} (release tarball not yet published)."
  DEV_MODE=1
fi

# Cred-helper ships as its own tarball — extract it next to the CLI so
# git's credential helper can find it. (It used to be bundled inside
# platform-cli's npm pack, but that conflated two unrelated packages.)
if [ "${DEV_MODE:-0}" != "1" ]; then
  if curl -fsSL --output "${TMP}/platform-cred-helper.tgz" "${CRED_HELPER_URL}" 2>/dev/null; then
    rm -rf "${PLATFORM_HOME}/cred-helper"
    mkdir -p "${PLATFORM_HOME}/cred-helper"
    tar -xzf "${TMP}/platform-cred-helper.tgz" -C "${PLATFORM_HOME}/cred-helper"
    ln -sfn "${PLATFORM_HOME}/cred-helper/platform-cred-helper.mjs" "${PLATFORM_BIN}/platform-cred-helper"
    chmod +x "${PLATFORM_BIN}/platform-cred-helper" 2>/dev/null || true
    ok "Credential helper installed at ${PLATFORM_BIN}/platform-cred-helper"
  else
    warn "Could not download ${CRED_HELPER_URL} (cred-helper tarball not yet published)."
    DEV_MODE=1
  fi
fi

if [ "${DEV_MODE:-0}" = "1" ]; then
  warn "Dev-mode fallback: clone enterprise-apps and run:"
  warn "    pnpm --filter @enterprise/platform-cli build"
  warn "    pnpm --filter @enterprise/platform-cli link"
  warn "    cp tools/platform-cred-helper/platform-cred-helper.mjs ${PLATFORM_BIN}/"
fi

# 6. PATH wiring ------------------------------------------------------
add_to_path_line='export PATH="$HOME/.platform/bin:$PATH"'
sentinel="# >>> platform-cli managed >>>"
for rc in "${HOME}/.zshrc" "${HOME}/.bashrc"; do
  [ -f "${rc}" ] || continue
  if ! grep -qF "${sentinel}" "${rc}"; then
    {
      printf '\n%s\n' "${sentinel}"
      printf '%s\n' "${add_to_path_line}"
      printf '[ -f "$HOME/.platform/env" ] && . "$HOME/.platform/env"\n'
      printf '# <<< platform-cli managed <<<\n'
    } >> "${rc}"
    ok "Added platform paths to ${rc}"
  fi
done

# 7. Cred-helper config -----------------------------------------------
PROXY_HOST=$(node -e "console.log(new URL('${PLATFORM_PROXY_BASE_URL}').host)" 2>/dev/null \
  || python3 -c "from urllib.parse import urlparse; print(urlparse('${PLATFORM_PROXY_BASE_URL}').netloc)")
mkdir -p "${PLATFORM_HOME}"
cat > "${PLATFORM_HOME}/cred-helper.json" <<EOF
{
  "proxyHost": "${PROXY_HOST}",
  "proxyBaseUrl": "${PLATFORM_PROXY_BASE_URL}"
}
EOF

# 8. Run platform login ----------------------------------------------
say ""
say "Almost done — sign in via your browser to mint a token."
export PLATFORM_PROXY_BASE_URL
export APP_STORE_URL
export API_GATEWAY_URL
export PATH="${PLATFORM_BIN}:${PATH}"
"${PLATFORM_BIN}/platform" login || err "platform login failed; re-run when you're ready."

ok "All set. Open Claude Code and tell it what to build."
