/**
 * OS keychain abstraction.
 *
 * We deliberately avoid `keytar`. Reasons documented in the package
 * README (TL;DR: native bindings + per-platform prebuilds add risk for
 * a tool whose installer must Just Work on a brand-new machine, and
 * pulling a native module into the monorepo's `pnpm install` graph adds
 * surface for build failures we don't need). Instead we shell out to:
 *
 *   - macOS:   `security`        (preinstalled)
 *   - Windows: `cmdkey`          (preinstalled)
 *   - Linux:   `secret-tool`     (libsecret; ships with most desktop
 *                                  distros; if missing we fall back to
 *                                  a 0600 file at ~/.platform/keychain
 *                                  and emit a warning)
 *
 * The interface is:
 *   - getSecret(service, account)        → string | null
 *   - setSecret(service, account, value) → void
 *   - deleteSecret(service, account)     → void
 *
 * All operations are synchronous because (a) they're rare, (b) keeping
 * them sync makes the credential helper trivial, and (c) it makes
 * tests dead simple to mock.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";

export interface Keychain {
  getSecret(service: string, account: string): string | null;
  setSecret(service: string, account: string, value: string): void;
  deleteSecret(service: string, account: string): void;
}

/* ───────────────────────── macOS — `security` ───────────────────────── */

class MacosKeychain implements Keychain {
  /**
   * Resolve an explicit keychain path so `security` never falls into
   * the "no default keychain" code path that prompts the user with a
   * destructive "Reset to Defaults" dialog. We target the user's
   * login keychain by absolute path.
   *
   * On modern macOS (10.13+) login keychain lives at
   * `~/Library/Keychains/login.keychain-db`. Some older configs use
   * `login.keychain` (no `-db`). We pick whichever exists; if neither
   * exists (rare — usually means the user has no keychain at all)
   * we throw so the caller falls back to the sidecar.
   */
  private loginKeychainPath(): string {
    const home = process.env.HOME ?? homedir();
    const dbPath = join(home, "Library", "Keychains", "login.keychain-db");
    const legacyPath = join(home, "Library", "Keychains", "login.keychain");
    if (existsSync(dbPath)) return dbPath;
    if (existsSync(legacyPath)) return legacyPath;
    throw new Error(
      "No login keychain found at ~/Library/Keychains/login.keychain[-db]; falling back to file sidecar.",
    );
  }

  getSecret(service: string, account: string): string | null {
    try {
      const kc = this.loginKeychainPath();
      const out = execFileSync(
        "security",
        ["find-generic-password", "-s", service, "-a", account, "-w", kc],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      );
      return out.replace(/\n$/, "");
    } catch {
      // Either no entry, or no keychain — try the sidecar before giving up.
      return readSidecar(service, account);
    }
  }

  setSecret(service: string, account: string, value: string): void {
    try {
      const kc = this.loginKeychainPath();
      // -U updates if the entry exists, otherwise creates.
      // Targeting `kc` explicitly prevents the "Keychain Not Found" dialog.
      execFileSync(
        "security",
        ["add-generic-password", "-U", "-s", service, "-a", account, "-w", value, kc],
        { stdio: "ignore" },
      );
    } catch {
      // macOS keychain unavailable (locked, no login keychain, sandbox,
      // CI runner). Fall through to the file-based sidecar — the
      // doctor command flags that as a warning so the dev knows.
      writeSidecar(service, account, value);
    }
  }

  deleteSecret(service: string, account: string): void {
    try {
      const kc = this.loginKeychainPath();
      execFileSync(
        "security",
        ["delete-generic-password", "-s", service, "-a", account, kc],
        { stdio: "ignore" },
      );
    } catch {
      /* not present — fine */
    }
    // Always also remove the sidecar in case we wrote to it on a
    // prior fallback. Keeps state consistent.
    deleteSidecar(service, account);
  }
}

/* ───────────────────────── Windows — `cmdkey` ───────────────────────── */

class WindowsKeychain implements Keychain {
  private targetName(service: string, account: string): string {
    return `${service}:${account}`;
  }

  getSecret(service: string, account: string): string | null {
    // `cmdkey /list:<target>` prints the entry but NOT the password
    // (Windows protects this — passwords retrieved via cmdkey are only
    // accessible to the OS-level credential consumer). For our purposes
    // we mirror the password into a 0600 sidecar file. This is the
    // documented workaround for Node CLIs needing programmatic readback.
    return readSidecar(service, account);
  }

  setSecret(service: string, account: string, value: string): void {
    execFileSync(
      "cmdkey",
      [`/generic:${this.targetName(service, account)}`, `/user:${account}`, `/pass:${value}`],
      { stdio: "ignore" },
    );
    writeSidecar(service, account, value);
  }

  deleteSecret(service: string, account: string): void {
    try {
      execFileSync("cmdkey", [`/delete:${this.targetName(service, account)}`], {
        stdio: "ignore",
      });
    } catch {
      /* not present — fine */
    }
    deleteSidecar(service, account);
  }
}

/* ───────────────────── Linux — `secret-tool` (libsecret) ───────────────────── */

class LinuxKeychain implements Keychain {
  private hasSecretTool: boolean;

  constructor() {
    this.hasSecretTool = which("secret-tool");
  }

  getSecret(service: string, account: string): string | null {
    if (!this.hasSecretTool) return readSidecar(service, account);
    try {
      const out = execFileSync(
        "secret-tool",
        ["lookup", "service", service, "account", account],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      );
      return out.replace(/\n$/, "") || null;
    } catch {
      return null;
    }
  }

  setSecret(service: string, account: string, value: string): void {
    if (!this.hasSecretTool) {
      writeSidecar(service, account, value);
      return;
    }
    // secret-tool reads the secret from stdin.
    execFileSync(
      "secret-tool",
      ["store", "--label", `${service}:${account}`, "service", service, "account", account],
      { input: value, stdio: ["pipe", "ignore", "ignore"] },
    );
  }

  deleteSecret(service: string, account: string): void {
    if (!this.hasSecretTool) {
      deleteSidecar(service, account);
      return;
    }
    try {
      execFileSync("secret-tool", ["clear", "service", service, "account", account], {
        stdio: "ignore",
      });
    } catch {
      /* not present — fine */
    }
  }
}

/* ──────────────────────────── Sidecar fallback ──────────────────────────── */

/**
 * 0600 file at ~/.platform/keychain/<service>__<account>. Only used on
 * Windows (where cmdkey doesn't expose readback) and Linux without
 * libsecret. The threat model here is "single-user dev laptop" — we're
 * trading an OS keychain for filesystem permissions, which the
 * `platform doctor` command flags as a yellow warning.
 */

function sidecarPath(service: string, account: string): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_");
  return join(homedir(), ".platform", "keychain", `${safe(service)}__${safe(account)}`);
}

function writeSidecar(service: string, account: string, value: string): void {
  const path = sidecarPath(service, account);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, value, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function readSidecar(service: string, account: string): string | null {
  const path = sidecarPath(service, account);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8");
}

function deleteSidecar(service: string, account: string): void {
  const path = sidecarPath(service, account);
  if (existsSync(path)) rmSync(path, { force: true });
}

/* ──────────────────────────────── helpers ──────────────────────────────── */

function which(cmd: string): boolean {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

let cached: Keychain | null = null;

/** Return the platform-appropriate keychain implementation (memoised). */
export function getKeychain(): Keychain {
  if (cached) return cached;
  switch (platform()) {
    case "darwin":
      cached = new MacosKeychain();
      break;
    case "win32":
      cached = new WindowsKeychain();
      break;
    default:
      cached = new LinuxKeychain();
      break;
  }
  return cached;
}

/** Test seam — replace the singleton with an in-memory fake. */
export function setKeychain(k: Keychain): void {
  cached = k;
}

/** Test seam — discard memoised instance. */
export function resetKeychain(): void {
  cached = null;
}

/** Stable identifiers shared between the CLI and the credential helper. */
export const KEYCHAIN_SERVICE = "platform-cli";
export const KEYCHAIN_ACCOUNT_TOKEN = "dgt";
export const KEYCHAIN_ACCOUNT_EXPIRES = "dgt-expires-at";
