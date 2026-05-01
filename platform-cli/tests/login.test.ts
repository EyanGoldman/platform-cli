/**
 * End-to-end login test. We mock:
 *   - platform-api (issueGitToken, fetchDevSkills) at the module level
 *   - claude-cli (marketplaceAdd, pluginInstall) via setClaudeCli
 *   - keychain via setKeychain
 *   - browser via setBrowserOpener
 *   - HOME via overriding the homedir
 *   - git-helper.configureGitCredentialHelper (it shells out to `git`)
 *
 * The loopback server is real — we open it, fire a fetch at it
 * ourselves, and let the rest of the pipeline run.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Keychain } from "../src/keychain.js";

vi.mock("../src/platform-api.js", async () => {
  const actual =
    // eslint-disable-next-line @typescript-eslint/consistent-type-imports
    await vi.importActual<typeof import("../src/platform-api.js")>("../src/platform-api.js");
  return {
    ...actual,
    issueGitToken: vi.fn(),
    fetchDevSkills: vi.fn(),
  };
});

vi.mock("../src/git-helper.js", async () => {
  const actual =
    // eslint-disable-next-line @typescript-eslint/consistent-type-imports
    await vi.importActual<typeof import("../src/git-helper.js")>("../src/git-helper.js");
  return {
    ...actual,
    configureGitCredentialHelper: vi.fn(),
    helperBinaryExists: vi.fn().mockReturnValue(true),
    readGitCredentialHelper: vi.fn().mockReturnValue({
      helperPath: null,
      useHttpPath: null,
    }),
  };
});

import * as api from "../src/platform-api.js";
import * as git from "../src/git-helper.js";
import { setKeychain, resetKeychain } from "../src/keychain.js";
import { setBrowserOpener, resetBrowserOpener } from "../src/browser.js";
import { setClaudeCli, resetClaudeCli, type ClaudeCli } from "../src/claude-cli.js";
import { runLogin } from "../src/commands/login.js";

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

class FakeClaude implements ClaudeCli {
  marketplaceAdd = vi.fn().mockResolvedValue(undefined);
  pluginInstall = vi.fn().mockResolvedValue(undefined);
  isAvailable = vi.fn().mockResolvedValue(true);
}

let home: string;
let kc: InMemoryKeychain;
let claude: FakeClaude;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "platform-cli-home-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.PLATFORM_PROXY_BASE_URL = "https://platform.test";
  process.env.APP_STORE_URL = "https://platform.test";
  process.env.API_GATEWAY_URL = "https://gw.test";

  kc = new InMemoryKeychain();
  setKeychain(kc);

  claude = new FakeClaude();
  setClaudeCli(claude);

  vi.mocked(api.issueGitToken).mockResolvedValue({
    id: "tok_1",
    name: "test-host",
    plaintext: "dgt_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    expiresAt: "2027-01-01T00:00:00.000Z",
  });
  vi.mocked(api.fetchDevSkills).mockResolvedValue({
    marketplaceName: "client-acme",
    plugins: [{ name: "core" }, { name: "deployment" }],
  });

  vi.mocked(git.configureGitCredentialHelper).mockReturnValue({
    keys: ["credential.https://platform.test.helper", "credential.https://platform.test.useHttpPath"],
    values: [join(home, ".platform/bin/platform-cred-helper"), "true"],
  });

  // The browser opener fires a request at the loopback URL so the
  // login flow proceeds without human intervention.
  setBrowserOpener({
    open(url) {
      const parsed = new URL(url);
      const redirectUri = parsed.searchParams.get("redirect_uri")!;
      // Mimic the SSO 302: the redirect lands on the loopback with a
      // platform_token. We do this on a microtask so the listener has
      // already attached.
      setTimeout(() => {
        const target = new URL(redirectUri);
        target.searchParams.set("platform_token", makeJwt({ clientSlug: "acme" }));
        void fetch(target.toString());
      }, 10);
    },
  });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  resetKeychain();
  resetBrowserOpener();
  resetClaudeCli();
  delete process.env.PLATFORM_PROXY_BASE_URL;
  delete process.env.APP_STORE_URL;
  delete process.env.API_GATEWAY_URL;
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function makeJwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.sig`;
}

describe("runLogin", () => {
  it("happy path: writes keychain, env file, settings.json, and calls claude", async () => {
    const code = await runLogin([]);
    expect(code).toBe(0);

    // Keychain
    expect(kc.getSecret("platform-cli", "dgt")).toBe(
      "dgt_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    );
    expect(kc.getSecret("platform-cli", "dgt-expires-at")).toBe("2027-01-01T00:00:00.000Z");

    // ~/.platform/env
    const envPath = join(home, ".platform", "env");
    expect(existsSync(envPath)).toBe(true);
    const envContent = readFileSync(envPath, "utf8");
    expect(envContent).toContain("PLATFORM_NPM_TOKEN=");
    expect(envContent).toContain("dgt_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");

    // ~/.claude/settings.json
    const settingsPath = join(home, ".claude", "settings.json");
    expect(existsSync(settingsPath)).toBe(true);
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(settings.extraKnownMarketplaces["client-acme"].source.url).toBe(
      "https://platform.test/api/v1/git/marketplace.git",
    );
    expect(settings.enabledPlugins).toEqual({
      "core@client-acme": true,
      "deployment@client-acme": true,
    });

    // Git helper configured
    expect(git.configureGitCredentialHelper).toHaveBeenCalledWith(
      expect.objectContaining({ host: "platform.test" }),
    );

    // Claude commands ran (empirical-test-result outcome (c))
    expect(claude.marketplaceAdd).toHaveBeenCalledWith(
      "https://platform.test/api/v1/git/marketplace.git",
    );
    expect(claude.pluginInstall).toHaveBeenCalledWith("core", "client-acme");
    expect(claude.pluginInstall).toHaveBeenCalledWith("deployment", "client-acme");
  });

  it("token-exchange failure aborts before touching keychain or settings", async () => {
    vi.mocked(api.issueGitToken).mockRejectedValueOnce(new Error("401 Unauthorized"));
    await expect(runLogin([])).rejects.toThrow(/401 Unauthorized/);

    expect(kc.store.size).toBe(0);
    expect(existsSync(join(home, ".platform", "env"))).toBe(false);
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);
    expect(claude.marketplaceAdd).not.toHaveBeenCalled();
  });

  it("preserves unrelated keys when merging settings.json", async () => {
    // Pre-populate ~/.claude/settings.json with the user's existing keys.
    const settingsPath = join(home, ".claude", "settings.json");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify({
        model: "claude-opus",
        permissions: { allow: ["bash:git"] },
        extraKnownMarketplaces: {
          "user-personal": { source: { source: "url", url: "https://personal" } },
        },
      }),
    );

    await runLogin([]);

    const after = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(after.model).toBe("claude-opus");
    expect(after.permissions).toEqual({ allow: ["bash:git"] });
    expect(after.extraKnownMarketplaces["user-personal"]).toBeDefined();
    expect(after.extraKnownMarketplaces["client-acme"]).toBeDefined();
  });

  it("aborts when settings.json is corrupt rather than overwriting it", async () => {
    const settingsPath = join(home, ".claude", "settings.json");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(settingsPath, "{not json");

    await expect(runLogin([])).rejects.toThrow(/parse|JSON|Could not/i);
    // Original on disk
    expect(readFileSync(settingsPath, "utf8")).toBe("{not json");
  });

  it("fails clearly if claude plugin install errors", async () => {
    claude.pluginInstall.mockRejectedValueOnce(new Error("plugin not found"));
    await expect(runLogin([])).rejects.toThrow(/Failed to install plugin/);
  });

  it("warns + exits 0 if claude is not available", async () => {
    claude.isAvailable.mockResolvedValueOnce(false);
    const code = await runLogin([]);
    expect(code).toBe(0);
    expect(claude.marketplaceAdd).not.toHaveBeenCalled();
    // Token + env are still written so the next `platform login` after
    // installing Claude Code can pick up where it left off.
    expect(kc.getSecret("platform-cli", "dgt")).toBeTruthy();
  });

  it("respects --skip-claude-install", async () => {
    const code = await runLogin(["--skip-claude-install"]);
    expect(code).toBe(0);
    expect(claude.marketplaceAdd).not.toHaveBeenCalled();
    expect(claude.pluginInstall).not.toHaveBeenCalled();
  });
});
