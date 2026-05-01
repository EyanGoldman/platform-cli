/**
 * Configure the git credential helper for the platform host.
 *
 * `git config --global credential.https://<host>.helper "<path>"` makes
 * git invoke our helper for every HTTPS request to that host. We also
 * set `useHttpPath true` so subpath URLs (the deploy URL changes per
 * app) all match the same credential entry.
 *
 * The helper binary is always co-located with the CLI binary at
 * `~/.platform/bin/platform-cred-helper`. The installer sets that up;
 * we just write the absolute path here.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface GitHelperConfig {
  /** Just the host part of PLATFORM_PROXY_BASE_URL — e.g. `platform.example.com`. */
  host: string;
  /** Absolute path to the credential helper binary. */
  helperPath: string;
}

/** Effective home — prefers process.env.HOME for test parity on
 * platforms where libuv's homedir lookup ignores HOME. */
function effectiveHome(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? homedir();
}

export function defaultHelperPath(home: string = effectiveHome()): string {
  // On Windows, `git` accepts forward slashes here, so a single
  // canonical form works for all platforms.
  return join(home, ".platform", "bin", "platform-cred-helper");
}

/** Configure git for the platform host. Idempotent: subsequent runs
 * just overwrite with the same values. Returns the two `git config`
 * keys we set, for use in `platform doctor`. */
export function configureGitCredentialHelper(args: GitHelperConfig): {
  keys: [string, string];
  values: [string, string];
} {
  const helperKey = `credential.https://${args.host}.helper`;
  const useHttpPathKey = `credential.https://${args.host}.useHttpPath`;
  // Per git-credential(1): "If an empty string appears, the list is
  // cleared and processing starts over." We replace the helper list for
  // this URL with [<empty>, <ours>] so any system-wide helper
  // (e.g. Apple's `osxkeychain` from Xcode's git) is excluded.
  // Without this, git fans `store`/`erase` out to every helper,
  // triggering the macOS "Keychain Not Found" dialog when the
  // osxkeychain helper tries to write and the user has no default
  // keychain set.
  // `--unset-all` exits 5 when the key has no values yet; that's fine.
  tryRunGit(["config", "--global", "--unset-all", helperKey]);
  runGit(["config", "--global", "--add", helperKey, ""]);
  runGit(["config", "--global", "--add", helperKey, args.helperPath]);
  runGit(["config", "--global", useHttpPathKey, "true"]);
  return {
    keys: [helperKey, useHttpPathKey],
    values: [args.helperPath, "true"],
  };
}

/** Read the helper config back. Returns null if not set. */
export function readGitCredentialHelper(host: string): {
  helperPath: string | null;
  useHttpPath: string | null;
} {
  return {
    helperPath: tryGitConfigGet(`credential.https://${host}.helper`),
    useHttpPath: tryGitConfigGet(`credential.https://${host}.useHttpPath`),
  };
}

/** Verify the helper binary actually exists on disk. */
export function helperBinaryExists(path: string): boolean {
  return existsSync(path);
}

function runGit(args: string[]): void {
  execFileSync("git", args, { stdio: "ignore" });
}

function tryRunGit(args: string[]): void {
  try {
    runGit(args);
  } catch {
    /* tolerate non-zero exits (e.g. --unset-all on an absent key) */
  }
}

function tryGitConfigGet(key: string): string | null {
  try {
    const out = execFileSync("git", ["config", "--global", "--get", key], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.replace(/\n$/, "") || null;
  } catch {
    return null;
  }
}
