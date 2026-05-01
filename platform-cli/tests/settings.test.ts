import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildClientSettings,
  mergeAndWriteSettings,
  mergeSettings,
  readSettings,
  SettingsParseError,
  writeSettings,
} from "../src/settings.js";

let dir: string;
let settingsPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "platform-cli-test-"));
  settingsPath = join(dir, "settings.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readSettings", () => {
  it("returns {} when file does not exist", () => {
    expect(readSettings(settingsPath)).toEqual({});
  });

  it("returns {} on empty file", () => {
    writeFileSync(settingsPath, "");
    expect(readSettings(settingsPath)).toEqual({});
  });

  it("throws SettingsParseError on invalid JSON", () => {
    writeFileSync(settingsPath, "{ not json");
    expect(() => readSettings(settingsPath)).toThrow(SettingsParseError);
  });

  it("throws on non-object root (array)", () => {
    writeFileSync(settingsPath, "[1, 2, 3]");
    expect(() => readSettings(settingsPath)).toThrow(SettingsParseError);
  });
});

describe("mergeSettings", () => {
  it("preserves unrelated existing keys", () => {
    const base = {
      model: "claude-opus",
      theme: "dark",
      permissions: { allow: ["bash"] },
    };
    const additions = {
      extraKnownMarketplaces: { foo: { source: { source: "url" as const, url: "https://x" } } },
    };
    const merged = mergeSettings(base, additions);
    expect(merged.model).toBe("claude-opus");
    expect(merged.theme).toBe("dark");
    expect(merged.permissions).toEqual({ allow: ["bash"] });
    expect(merged.extraKnownMarketplaces?.foo).toBeDefined();
  });

  it("merges marketplaces and enabledPlugins (additions win)", () => {
    const base = {
      extraKnownMarketplaces: {
        existing: { source: { source: "url" as const, url: "https://existing" } },
      },
      enabledPlugins: { "x@existing": true },
    };
    const additions = {
      extraKnownMarketplaces: {
        platform: { source: { source: "url" as const, url: "https://platform" } },
      },
      enabledPlugins: { "core@platform": true },
    };
    const merged = mergeSettings(base, additions);
    expect(Object.keys(merged.extraKnownMarketplaces ?? {})).toEqual(["existing", "platform"]);
    expect(merged.enabledPlugins).toEqual({
      "x@existing": true,
      "core@platform": true,
    });
  });

  it("additions override on key collision", () => {
    const base = {
      extraKnownMarketplaces: {
        platform: { source: { source: "url" as const, url: "https://OLD" } },
      },
    };
    const additions = {
      extraKnownMarketplaces: {
        platform: { source: { source: "url" as const, url: "https://NEW" } },
      },
    };
    const merged = mergeSettings(base, additions);
    expect(merged.extraKnownMarketplaces?.platform?.source.url).toBe("https://NEW");
  });
});

describe("writeSettings", () => {
  it("writes pretty-printed JSON with trailing newline", () => {
    writeSettings({ enabledPlugins: { "core@platform": true } }, settingsPath);
    const raw = readFileSync(settingsPath, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(JSON.parse(raw)).toEqual({ enabledPlugins: { "core@platform": true } });
  });

  it("creates parent directory if missing", () => {
    const nested = join(dir, "nested", "deep", "settings.json");
    writeSettings({}, nested);
    expect(readFileSync(nested, "utf8")).toMatch(/\{\}/);
  });
});

describe("mergeAndWriteSettings", () => {
  it("merges into an existing complex file without dropping keys", () => {
    writeFileSync(
      settingsPath,
      JSON.stringify({
        model: "claude-opus",
        permissions: { allow: ["bash"], deny: [] },
        extraKnownMarketplaces: {
          custom: { source: { source: "url", url: "https://custom" } },
        },
      }),
    );

    mergeAndWriteSettings(
      buildClientSettings({
        marketplaceName: "client-acme",
        marketplaceUrl: "https://platform/api/v1/git/marketplace",
        pluginNames: ["core", "deployment", "debugging"],
      }),
      settingsPath,
    );

    const after = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(after.model).toBe("claude-opus");
    expect(after.permissions).toEqual({ allow: ["bash"], deny: [] });
    expect(after.extraKnownMarketplaces.custom).toBeDefined();
    expect(after.extraKnownMarketplaces["client-acme"]).toEqual({
      source: { source: "url", url: "https://platform/api/v1/git/marketplace" },
    });
    expect(after.enabledPlugins).toEqual({
      "core@client-acme": true,
      "deployment@client-acme": true,
      "debugging@client-acme": true,
    });
  });

  it("refuses to overwrite a corrupted settings.json", () => {
    writeFileSync(settingsPath, "{this is not json");
    expect(() =>
      mergeAndWriteSettings(
        buildClientSettings({
          marketplaceName: "client-acme",
          marketplaceUrl: "https://platform",
          pluginNames: ["core"],
        }),
        settingsPath,
      ),
    ).toThrow(SettingsParseError);
    // Original content is still on disk.
    expect(readFileSync(settingsPath, "utf8")).toBe("{this is not json");
  });
});

describe("buildClientSettings", () => {
  it("emits one entry per plugin keyed by `<name>@<marketplace>`", () => {
    const out = buildClientSettings({
      marketplaceName: "client-x",
      marketplaceUrl: "https://x",
      pluginNames: ["a", "b"],
    });
    expect(out.enabledPlugins).toEqual({
      "a@client-x": true,
      "b@client-x": true,
    });
  });
});
