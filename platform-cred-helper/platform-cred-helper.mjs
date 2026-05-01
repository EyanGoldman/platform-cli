#!/usr/bin/env node
/**
 * Git credential helper.
 *
 * Spec: https://git-scm.com/docs/git-credential — git invokes us with
 * one of `get`, `store`, `erase`, and pipes a stream of `key=value\n`
 * lines on stdin terminated by a blank line. `get` is the only verb we
 * implement meaningfully; `store` and `erase` are no-ops (we manage
 * the token via the platform CLI, not via git's credential prompt).
 *
 * For `get`: if the inbound `host` matches our configured platform
 * proxy host, look up the DeveloperGitToken from the OS keychain and
 * print
 *   username=x-platform
 *   password=<token>
 * to stdout. Anything else: print nothing — git falls back to the next
 * helper in the chain.
 *
 * The configured platform host is resolved at runtime from
 * `PLATFORM_PROXY_BASE_URL`, falling back to `~/.platform/cred-helper.json`
 * (written by the installer), falling back to a built-in default.
 *
 * Standalone Node script (no TypeScript build step) so the same file
 * can be symlinked into `~/.platform/bin` by the installer.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir, platform as osPlatform } from "node:os";
import { join } from "node:path";

const KEYCHAIN_SERVICE = "platform-cli";
const KEYCHAIN_ACCOUNT = "dgt";
const DEFAULT_HOST = "platform.example.com";

await main();

async function main() {
  const verb = process.argv[2];
  if (verb === "store" || verb === "erase") {
    await drainStdin();
    return;
  }
  if (verb !== "get") {
    await drainStdin();
    return;
  }

  const input = parseInput(await readStdin());
  if (input.protocol !== "https") return;

  const platformHost = resolvePlatformHost();
  if (!hostMatches(input.host ?? "", platformHost)) return;

  const token = readKeychain(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
  if (!token) return;

  process.stdout.write(`username=x-platform\npassword=${token}\n`);
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function drainStdin() {
  try {
    await readStdin();
  } catch {
    /* ignore */
  }
}

function parseInput(raw) {
  const result = {};
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    result[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return result;
}

function hostMatches(actual, expected) {
  const a = actual.split(":")[0].toLowerCase();
  const e = expected.split(":")[0].toLowerCase();
  return a === e;
}

function resolvePlatformHost() {
  const fromEnv = process.env.PLATFORM_PROXY_BASE_URL;
  if (fromEnv) {
    try {
      return new URL(fromEnv).host;
    } catch {
      /* fall through */
    }
  }
  const path = join(homedir(), ".platform", "cred-helper.json");
  if (existsSync(path)) {
    try {
      const cfg = JSON.parse(readFileSync(path, "utf8"));
      if (cfg && typeof cfg.proxyHost === "string") return cfg.proxyHost;
    } catch {
      /* fall through */
    }
  }
  return DEFAULT_HOST;
}

function readKeychain(service, account) {
  // Test seam: $PLATFORM_CRED_HELPER_FAKE_TOKEN short-circuits the OS
  // keychain read so tests don't need to fight macOS's per-binary
  // ACL prompts. Production callers never set this env var.
  if (process.env.PLATFORM_CRED_HELPER_FAKE_TOKEN) {
    return process.env.PLATFORM_CRED_HELPER_FAKE_TOKEN;
  }
  switch (osPlatform()) {
    case "darwin":
      return readMacKeychain(service, account);
    case "win32":
      return readSidecar(service, account);
    default:
      return readLinuxKeychain(service, account);
  }
}

function readMacKeychain(service, account) {
  // Resolve the explicit login keychain so `security` never falls into
  // the "no default keychain" code path that prompts the user with a
  // destructive "Reset to Defaults" dialog (mirrors keychain.ts in the
  // CLI). If the keychain itself doesn't exist (test home, CI runner,
  // sandbox), fall through to the file sidecar that the CLI's
  // setSecret writes in those environments.
  const home = process.env.HOME ?? homedir();
  const dbPath = join(home, "Library", "Keychains", "login.keychain-db");
  const legacyPath = join(home, "Library", "Keychains", "login.keychain");
  const kc = existsSync(dbPath) ? dbPath : existsSync(legacyPath) ? legacyPath : null;
  if (kc) {
    try {
      const out = execFileSync(
        "security",
        ["find-generic-password", "-s", service, "-a", account, "-w", kc],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      );
      const v = out.replace(/\n$/, "");
      if (v) return v;
    } catch {
      /* fall through to sidecar */
    }
  }
  return readSidecar(service, account);
}

function readLinuxKeychain(service, account) {
  try {
    const out = execFileSync(
      "secret-tool",
      ["lookup", "service", service, "account", account],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const v = out.replace(/\n$/, "");
    if (v) return v;
  } catch {
    /* fall through to sidecar */
  }
  return readSidecar(service, account);
}

function readSidecar(service, account) {
  const safe = (s) => s.replace(/[^A-Za-z0-9._-]/g, "_");
  const path = join(homedir(), ".platform", "keychain", `${safe(service)}__${safe(account)}`);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8");
}
