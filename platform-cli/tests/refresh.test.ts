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
  };
});

import * as api from "../src/platform-api.js";
import { setKeychain, resetKeychain } from "../src/keychain.js";
import { setBrowserOpener, resetBrowserOpener } from "../src/browser.js";
import { runRefresh } from "../src/commands/refresh.js";

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

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "platform-cli-refresh-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.PLATFORM_PROXY_BASE_URL = "https://platform.test";
  process.env.APP_STORE_URL = "https://platform.test";
  process.env.API_GATEWAY_URL = "https://gw.test";

  kc = new InMemoryKeychain();
  setKeychain(kc);
  // Pre-existing token from a previous login
  kc.setSecret("platform-cli", "dgt", "dgt_OLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLD");
  kc.setSecret("platform-cli", "dgt-expires-at", "2020-01-01T00:00:00.000Z");

  vi.mocked(api.issueGitToken).mockResolvedValue({
    id: "tok_2",
    name: "test-host",
    plaintext: "dgt_NEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEW0",
    expiresAt: "2027-12-01T00:00:00.000Z",
  });

  setBrowserOpener({
    open(url) {
      const parsed = new URL(url);
      const redirectUri = parsed.searchParams.get("redirect_uri")!;
      setTimeout(() => {
        const target = new URL(redirectUri);
        target.searchParams.set("platform_token", "h.eyJjbGllbnRTbHVnIjoiYWNtZSJ9.s");
        void fetch(target.toString());
      }, 10);
    },
  });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  resetKeychain();
  resetBrowserOpener();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  delete process.env.PLATFORM_PROXY_BASE_URL;
  delete process.env.APP_STORE_URL;
  delete process.env.API_GATEWAY_URL;
});

describe("runRefresh", () => {
  it("overwrites the keychain entries with the freshly minted token", async () => {
    const code = await runRefresh([]);
    expect(code).toBe(0);
    expect(kc.getSecret("platform-cli", "dgt")).toBe(
      "dgt_NEWNEWNEWNEWNEWNEWNEWNEWNEWNEWNEW0",
    );
    expect(kc.getSecret("platform-cli", "dgt-expires-at")).toBe("2027-12-01T00:00:00.000Z");

    // ~/.platform/env regenerated
    const envPath = join(home, ".platform", "env");
    expect(existsSync(envPath)).toBe(true);
    expect(readFileSync(envPath, "utf8")).toContain("dgt_NEWNEWNEW");
  });
});
