import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Keychain } from "../src/keychain.js";
import { setKeychain, resetKeychain } from "../src/keychain.js";

vi.mock("../src/git-helper.js", async () => {
  const actual =
    // eslint-disable-next-line @typescript-eslint/consistent-type-imports
    await vi.importActual<typeof import("../src/git-helper.js")>("../src/git-helper.js");
  return {
    ...actual,
    readGitCredentialHelper: vi.fn(),
    helperBinaryExists: vi.fn(),
  };
});


import * as git from "../src/git-helper.js";
import { setRunner, resetRunner } from "../src/runners.js";
import { runDoctor } from "../src/commands/doctor.js";

type RunImpl = (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

const happyRunner: RunImpl = async (file) => {
  if (file === "pnpm") return { stdout: "10.30.3\n", stderr: "" };
  if (file === "claude") return { stdout: "1.0.0\n", stderr: "" };
  if (file === "docker") return { stdout: "Docker is up\n", stderr: "" };
  return { stdout: "", stderr: "" };
};

class InMemoryKeychain implements Keychain {
  store = new Map<string, string>();
  getSecret(s: string, a: string) {
    return this.store.get(`${s}::${a}`) ?? null;
  }
  setSecret(s: string, a: string, v: string) {
    this.store.set(`${s}::${a}`, v);
  }
  deleteSecret(s: string, a: string) {
    this.store.delete(`${s}::${a}`);
  }
}

let home: string;
let kc: InMemoryKeychain;
let originalLog: typeof process.stdout.write;
let logged: string;

// CI runs on Node 20 today; doctor's Node-version check requires >= v22.
// We're testing the *doctor logic*, not the runner's Node version, so
// mock process.version to a passing value for the duration of each test.
let originalNodeVersion: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "platform-cli-doctor-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.PLATFORM_PROXY_BASE_URL = "https://platform.test";
  originalNodeVersion = process.version;
  Object.defineProperty(process, "version", { value: "v22.0.0", configurable: true });

  kc = new InMemoryKeychain();
  setKeychain(kc);

  logged = "";
  originalLog = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array, ..._rest: unknown[]) => {
    logged += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

  setRunner(happyRunner);

  vi.mocked(git.readGitCredentialHelper).mockReturnValue({
    helperPath: join(home, ".platform", "bin", "platform-cred-helper"),
    useHttpPath: "true",
  });
  vi.mocked(git.helperBinaryExists).mockReturnValue(true);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  resetKeychain();
  resetRunner();
  process.stdout.write = originalLog;
  vi.restoreAllMocks();
  vi.clearAllMocks();
  delete process.env.PLATFORM_PROXY_BASE_URL;
  Object.defineProperty(process, "version", { value: originalNodeVersion, configurable: true });
});

function seedHappyState(): void {
  // Token + expiry in keychain
  kc.setSecret("platform-cli", "dgt", "dgt_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  kc.setSecret(
    "platform-cli",
    "dgt-expires-at",
    new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  );
  // settings.json
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(
    join(home, ".claude", "settings.json"),
    JSON.stringify({
      extraKnownMarketplaces: {
        "client-acme": { source: { source: "url", url: "https://x" } },
      },
      enabledPlugins: { "core@client-acme": true },
    }),
  );
  // ~/.platform/env
  mkdirSync(join(home, ".platform"), { recursive: true });
  writeFileSync(join(home, ".platform", "env"), "export PLATFORM_NPM_TOKEN=x\n");
  process.env.PLATFORM_NPM_TOKEN = "x";
}

describe("runDoctor", () => {
  it("happy path: every check green, exit 0", async () => {
    seedHappyState();
    const code = await runDoctor([]);
    expect(code).toBe(0);
    // No fail markers in the output.
    expect(logged).not.toContain("✗");
    expect(logged).toContain("Developer git token in keychain");
    expect(logged).toContain("Token freshness");
  });

  it("fails when keychain is empty", async () => {
    seedHappyState();
    kc.deleteSecret("platform-cli", "dgt");
    const code = await runDoctor([]);
    expect(code).toBe(1);
    expect(logged).toMatch(/✗ Developer git token in keychain/);
    expect(logged).toMatch(/platform login/);
  });

  it("fails when token is expired", async () => {
    seedHappyState();
    kc.setSecret("platform-cli", "dgt-expires-at", new Date(Date.now() - 1000).toISOString());
    const code = await runDoctor([]);
    expect(code).toBe(1);
    expect(logged).toMatch(/Token freshness.*expired/);
  });

  it("warns when token expires soon", async () => {
    seedHappyState();
    kc.setSecret(
      "platform-cli",
      "dgt-expires-at",
      new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
    );
    const code = await runDoctor([]);
    expect(code).toBe(0);
    expect(logged).toMatch(/!.*Token freshness.*expires in/);
  });

  it("fails when settings.json is missing", async () => {
    seedHappyState();
    rmSync(join(home, ".claude", "settings.json"));
    const code = await runDoctor([]);
    expect(code).toBe(1);
    expect(logged).toMatch(/Marketplace registered/);
  });

  it("warns (does not fail) when claude is missing", async () => {
    seedHappyState();
    setRunner(async (file) => {
      if (file === "claude") throw new Error("ENOENT");
      if (file === "pnpm") return { stdout: "10.30.3\n", stderr: "" };
      if (file === "docker") return { stdout: "Docker up", stderr: "" };
      return { stdout: "", stderr: "" };
    });
    const code = await runDoctor([]);
    // Claude Code missing is a warning, not a hard fail — devs are
    // expected to install it themselves; the rest of the platform CLI
    // still works without it.
    expect(code).toBe(0);
    expect(logged).toMatch(/Claude Code/);
    expect(logged).toMatch(/!/); // warn marker
  });

  it("fails when docker is unreachable", async () => {
    seedHappyState();
    setRunner(async (file) => {
      if (file === "docker") throw new Error("daemon not running");
      if (file === "claude") return { stdout: "1.0.0", stderr: "" };
      if (file === "pnpm") return { stdout: "10.30.3\n", stderr: "" };
      return { stdout: "", stderr: "" };
    });
    const code = await runDoctor([]);
    expect(code).toBe(1);
    expect(logged).toMatch(/✗ Docker.*not reachable/);
  });
});
