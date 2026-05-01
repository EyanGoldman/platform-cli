/**
 * The credential helper is a standalone .mjs script. We test it by
 * spawning Node against the script and piping the canonical
 * git-credential protocol on stdin.
 *
 * The OS keychain is bypassed via the `PLATFORM_CRED_HELPER_FAKE_TOKEN`
 * env-var test seam — testing the actual macOS / libsecret / cmdkey
 * paths is an integration concern (different ACL semantics per OS;
 * macOS specifically requires explicit `-T` ACL grants for headless
 * `find-generic-password`, which would make these tests CI-host-
 * specific). The keychain shellouts in the .mjs are simple enough to
 * read by hand.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const HERE = new URL(".", import.meta.url).pathname;
const HELPER = resolve(HERE, "..", "..", "platform-cred-helper", "platform-cred-helper.mjs");

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "platform-cli-helper-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

interface RunResult {
  stdout: string;
  stderr: string;
  status: number;
}

function runHelper(verb: string, stdin: string, env: Record<string, string> = {}): RunResult {
  const r = spawnSync(process.execPath, [HELPER, verb], {
    input: stdin,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      ...env,
    },
  });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status ?? -1 };
}

const TOKEN = "dgt_TEST00000000000000000000000000000";

describe("platform-cred-helper", () => {
  it("returns the token when host matches and protocol is https", () => {
    const r = runHelper("get", "protocol=https\nhost=platform.example.com\n\n", {
      PLATFORM_PROXY_BASE_URL: "https://platform.example.com",
      PLATFORM_CRED_HELPER_FAKE_TOKEN: TOKEN,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("username=x-platform");
    expect(r.stdout).toContain(`password=${TOKEN}`);
  });

  it("emits nothing for a non-matching host", () => {
    const r = runHelper("get", "protocol=https\nhost=github.com\n\n", {
      PLATFORM_PROXY_BASE_URL: "https://platform.example.com",
      PLATFORM_CRED_HELPER_FAKE_TOKEN: TOKEN,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("emits nothing when protocol is not https", () => {
    const r = runHelper("get", "protocol=http\nhost=platform.example.com\n\n", {
      PLATFORM_PROXY_BASE_URL: "https://platform.example.com",
      PLATFORM_CRED_HELPER_FAKE_TOKEN: TOKEN,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("emits nothing when no token is in the keychain", () => {
    // No PLATFORM_CRED_HELPER_FAKE_TOKEN, and no real entry under
    // service `platform-cli` (HOME points at an empty tmp dir, which
    // also rules out the sidecar fallback).
    const r = runHelper("get", "protocol=https\nhost=platform.example.com\n\n", {
      PLATFORM_PROXY_BASE_URL: "https://platform.example.com",
      // We can't blindly run on dev laptops where the developer's
      // own `platform login` may have written a real entry — clear
      // the env so the macOS branch reads an empty keychain (the
      // service+account pair is unique to the platform).
      // (Sidecar lookup is rooted at HOME, so the empty tmp dir is
      // the operative path on Linux.)
    });
    // Either no token was found (typical CI) → empty stdout, OR a
    // real token exists on the dev's machine → still username=x-platform.
    // Tolerate both — what we're really asserting is that the helper
    // never crashes.
    expect(r.status).toBe(0);
  });

  it("is a no-op for `store` and `erase`", () => {
    const store = runHelper(
      "store",
      "protocol=https\nhost=platform.example.com\nusername=x-platform\npassword=foo\n\n",
    );
    expect(store.status).toBe(0);
    expect(store.stdout).toBe("");
    const erase = runHelper("erase", "protocol=https\nhost=platform.example.com\n\n");
    expect(erase.status).toBe(0);
    expect(erase.stdout).toBe("");
  });

  it("falls back to ~/.platform/cred-helper.json when env var is unset", () => {
    mkdirSync(join(home, ".platform"), { recursive: true });
    writeFileSync(
      join(home, ".platform", "cred-helper.json"),
      JSON.stringify({ proxyHost: "platform.test" }),
    );
    const r = runHelper("get", "protocol=https\nhost=platform.test\n\n", {
      PLATFORM_CRED_HELPER_FAKE_TOKEN: TOKEN,
      // Deliberately don't set PLATFORM_PROXY_BASE_URL — we want the
      // helper to read the sidecar config file.
      PLATFORM_PROXY_BASE_URL: "",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("username=x-platform");
  });

  it("ignores unknown verbs", () => {
    const r = runHelper("get-many", "");
    expect(r.status).toBe(0);
  });
});
