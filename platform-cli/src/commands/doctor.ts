/**
 * `platform doctor` — print a checklist with green/red/yellow markers.
 *
 * Each check is a small async function returning a `Check` result.
 * They run sequentially because a failure earlier (e.g. no `claude`
 * binary) often cascades, and the user reads them top-to-bottom anyway.
 *
 * No check throws — failures are captured into the result so the
 * remediation hint is always shown.
 */

import { existsSync } from "node:fs";
import { resolveConfig, urlHost } from "../config.js";
import {
  getKeychain,
  KEYCHAIN_ACCOUNT_EXPIRES,
  KEYCHAIN_ACCOUNT_TOKEN,
  KEYCHAIN_SERVICE,
} from "../keychain.js";
import { defaultSettingsPath, readSettings } from "../settings.js";
import {
  defaultHelperPath,
  helperBinaryExists,
  readGitCredentialHelper,
} from "../git-helper.js";
import { platformEnvPath } from "../shell-integration.js";
import { runCmd } from "../runners.js";

type Status = "ok" | "warn" | "fail";

interface Check {
  status: Status;
  label: string;
  detail?: string;
  remediation?: string;
}

const REQUIRED_NODE_MAJOR = 22;
const REQUIRED_PNPM = "10.30.3";

export async function runDoctor(_args: string[]): Promise<number> {
  const checks: Check[] = [];

  checks.push(checkNode());
  checks.push(await checkPnpm());
  checks.push(await checkClaude());
  checks.push(await checkDocker());
  checks.push(checkKeychainToken());
  checks.push(checkTokenFreshness());
  checks.push(checkSettings());
  checks.push(checkGitHelper());
  checks.push(checkPlatformNpmToken());
  checks.push(checkPlatformEnvFile());

  for (const c of checks) print(c);

  const anyFail = checks.some((c) => c.status === "fail");
  return anyFail ? 1 : 0;
}

function print(c: Check): void {
  const icon = c.status === "ok" ? "✓" : c.status === "warn" ? "!" : "✗";
  const line = `${icon} ${c.label}${c.detail ? ` — ${c.detail}` : ""}`;
  process.stdout.write(`${line}\n`);
  if (c.status !== "ok" && c.remediation) {
    process.stdout.write(`    ↳ ${c.remediation}\n`);
  }
}

/* ───────────────────────────── checks ───────────────────────────── */

function checkNode(): Check {
  const major = parseInt(process.version.replace(/^v/, "").split(".")[0] ?? "0", 10);
  if (major >= REQUIRED_NODE_MAJOR) {
    return { status: "ok", label: `Node ${process.version}` };
  }
  return {
    status: "fail",
    label: `Node ${process.version}`,
    detail: `need >= v${REQUIRED_NODE_MAJOR}`,
    remediation: `Install Node 22 (e.g. \`mise use -g node@${REQUIRED_NODE_MAJOR}\` or download from nodejs.org).`,
  };
}

async function checkPnpm(): Promise<Check> {
  try {
    const { stdout } = await runCmd("pnpm", ["--version"], { timeout: 5_000 });
    const version = stdout.trim();
    if (version === REQUIRED_PNPM) {
      return { status: "ok", label: `pnpm ${version}` };
    }
    return {
      status: "warn",
      label: `pnpm ${version}`,
      detail: `expected ${REQUIRED_PNPM}`,
      remediation: `Pin via \`mise use -g pnpm@${REQUIRED_PNPM}\` or \`corepack prepare pnpm@${REQUIRED_PNPM} --activate\`.`,
    };
  } catch {
    return {
      status: "fail",
      label: "pnpm",
      detail: "not installed",
      remediation: `Install pnpm: \`npm install -g pnpm@${REQUIRED_PNPM}\`.`,
    };
  }
}

async function checkClaude(): Promise<Check> {
  // Claude Code is the platform's baseline tool — devs are expected to
  // already have it on PATH. Surface as a warning (not a hard fail) if
  // missing, since the rest of the platform CLI still works without it
  // and the dev can install it themselves.
  try {
    const { stdout } = await runCmd("claude", ["--version"], { timeout: 5_000 });
    return { status: "ok", label: `Claude Code ${stdout.trim()}` };
  } catch {
    return {
      status: "warn",
      label: "Claude Code",
      detail: "not on PATH",
      remediation: "Install Claude Code (https://claude.ai/install) before using platform skills.",
    };
  }
}

async function checkDocker(): Promise<Check> {
  try {
    await runCmd("docker", ["info"], { timeout: 10_000 });
    return { status: "ok", label: "Docker daemon reachable" };
  } catch {
    return {
      status: "fail",
      label: "Docker",
      detail: "daemon not reachable",
      remediation: "Start Docker Desktop / OrbStack and try again.",
    };
  }
}

function checkKeychainToken(): Check {
  const token = getKeychain().getSecret(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT_TOKEN);
  if (!token) {
    return {
      status: "fail",
      label: "Developer git token in keychain",
      detail: "missing",
      remediation: "Run `platform login` to mint a token.",
    };
  }
  if (!token.startsWith("dgt_") || token.length !== 36) {
    return {
      status: "fail",
      label: "Developer git token in keychain",
      detail: "malformed",
      remediation: "Run `platform refresh` to re-mint your token.",
    };
  }
  return { status: "ok", label: "Developer git token in keychain" };
}

function checkTokenFreshness(): Check {
  const expiresAt = getKeychain().getSecret(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT_EXPIRES);
  if (!expiresAt) {
    return {
      status: "warn",
      label: "Token expiry recorded",
      detail: "no expiry stored",
      remediation: "Run `platform refresh` to re-mint your token.",
    };
  }
  const ts = Date.parse(expiresAt);
  if (Number.isNaN(ts)) {
    return {
      status: "warn",
      label: "Token expiry recorded",
      detail: "unparseable",
      remediation: "Run `platform refresh` to re-mint your token.",
    };
  }
  if (ts <= Date.now()) {
    return {
      status: "fail",
      label: "Token freshness",
      detail: `expired at ${expiresAt}`,
      remediation: "Run `platform refresh` to re-mint your token.",
    };
  }
  const daysLeft = Math.floor((ts - Date.now()) / (24 * 60 * 60 * 1000));
  if (daysLeft <= 7) {
    return {
      status: "warn",
      label: "Token freshness",
      detail: `expires in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`,
      remediation: "Run `platform refresh` soon to avoid mid-session expiry.",
    };
  }
  return { status: "ok", label: "Token freshness", detail: `${daysLeft} days remaining` };
}

function checkSettings(): Check {
  const path = defaultSettingsPath();
  if (!existsSync(path)) {
    return {
      status: "fail",
      label: "Marketplace registered in ~/.claude/settings.json",
      detail: "settings.json not found",
      remediation: "Run `platform login` to register the platform marketplace.",
    };
  }
  try {
    const settings = readSettings(path);
    const marketplaces = settings.extraKnownMarketplaces ?? {};
    const enabled = settings.enabledPlugins ?? {};
    if (Object.keys(marketplaces).length === 0) {
      return {
        status: "fail",
        label: "Marketplace registered in ~/.claude/settings.json",
        detail: "no marketplaces registered",
        remediation: "Run `platform login`.",
      };
    }
    const enabledCount = Object.values(enabled).filter(Boolean).length;
    return {
      status: "ok",
      label: "Marketplace registered in ~/.claude/settings.json",
      detail: `${Object.keys(marketplaces).length} marketplace(s), ${enabledCount} enabled plugin(s)`,
    };
  } catch (err) {
    return {
      status: "fail",
      label: "Marketplace registered in ~/.claude/settings.json",
      detail: err instanceof Error ? err.message : String(err),
      remediation: "Hand-fix the JSON, then re-run `platform login`.",
    };
  }
}

function checkGitHelper(): Check {
  const config = resolveConfig();
  const host = urlHost(config.proxyBaseUrl);
  const { helperPath, useHttpPath } = readGitCredentialHelper(host);
  if (!helperPath) {
    return {
      status: "fail",
      label: `Git credential helper for ${host}`,
      detail: "not configured",
      remediation: "Run `platform login`.",
    };
  }
  if (!helperBinaryExists(helperPath)) {
    return {
      status: "fail",
      label: `Git credential helper for ${host}`,
      detail: `helper binary missing: ${helperPath}`,
      remediation: "Re-run the platform installer (`curl -fsSL <install-url> | sh`).",
    };
  }
  const expectedHelper = defaultHelperPath();
  if (helperPath !== expectedHelper) {
    return {
      status: "warn",
      label: `Git credential helper for ${host}`,
      detail: `unexpected helper path: ${helperPath}`,
      remediation: `If this isn't intentional, run \`platform login\` to reset to ${expectedHelper}.`,
    };
  }
  if (useHttpPath !== "true") {
    return {
      status: "warn",
      label: `Git credential helper for ${host}`,
      detail: "useHttpPath not set",
      remediation: "Run `platform login` to fix.",
    };
  }
  return { status: "ok", label: `Git credential helper for ${host}` };
}

function checkPlatformNpmToken(): Check {
  if (process.env.PLATFORM_NPM_TOKEN) {
    return { status: "ok", label: "PLATFORM_NPM_TOKEN in shell env" };
  }
  return {
    status: "warn",
    label: "PLATFORM_NPM_TOKEN in shell env",
    detail: "not set in current shell",
    remediation: "Open a new terminal, or run `source ~/.platform/env`.",
  };
}

function checkPlatformEnvFile(): Check {
  const path = platformEnvPath();
  if (!existsSync(path)) {
    return {
      status: "fail",
      label: "~/.platform/env present",
      detail: "missing",
      remediation: "Run `platform login` to create it.",
    };
  }
  return { status: "ok", label: "~/.platform/env present" };
}
