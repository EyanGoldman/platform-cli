/**
 * ~/.claude/settings.json read / merge / atomic-write.
 *
 * The user may have arbitrary other keys in this file (model, theme,
 * permissions, custom hooks, other marketplaces...). We MUST NOT
 * overwrite or drop any of them. Strategy:
 *
 *   1. Read the existing file (treat ENOENT as `{}`).
 *   2. Deep-merge our additions into the parsed object.
 *   3. Write to a sibling `<name>.tmp` file with 0600 permissions.
 *   4. `fs.renameSync` over the original — atomic on POSIX, atomic on
 *      same-volume Windows since Node 14+.
 *
 * On a parse error we refuse to clobber: throw with the path so the
 * user can hand-fix, rather than silently nuking their config.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface MarketplaceEntry {
  source: { source: "url"; url: string };
}

export interface ClaudeSettings {
  extraKnownMarketplaces?: Record<string, MarketplaceEntry>;
  enabledPlugins?: Record<string, boolean>;
  [key: string]: unknown;
}

/** Effective home — prefers process.env.HOME so tests setting that env
 * var work even when libuv's homedir lookup ignores HOME. */
function effectiveHome(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? homedir();
}

/** Resolve the path the merge writes to. Tests override via the param. */
export function defaultSettingsPath(home: string = effectiveHome()): string {
  return join(home, ".claude", "settings.json");
}

export class SettingsParseError extends Error {
  constructor(
    public readonly path: string,
    public readonly cause: unknown,
  ) {
    super(
      `Could not parse ${path}; refusing to overwrite. Fix the JSON by hand or remove the file and re-run \`platform login\`.`,
    );
    this.name = "SettingsParseError";
  }
}

/** Read settings if present; return `{}` if absent; throw on bad JSON. */
export function readSettings(path: string = defaultSettingsPath()): ClaudeSettings {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("settings.json must be a JSON object");
    }
    return parsed as ClaudeSettings;
  } catch (err) {
    throw new SettingsParseError(path, err);
  }
}

/**
 * Merge `additions` over `base` (additions win on key collisions, but
 * sibling keys we don't touch are preserved). Currently we only merge
 * the two object-typed keys we care about; arbitrary other keys get the
 * shallow-copy treatment.
 */
export function mergeSettings(base: ClaudeSettings, additions: ClaudeSettings): ClaudeSettings {
  const merged: ClaudeSettings = { ...base };

  if (additions.extraKnownMarketplaces) {
    merged.extraKnownMarketplaces = {
      ...(base.extraKnownMarketplaces ?? {}),
      ...additions.extraKnownMarketplaces,
    };
  }

  if (additions.enabledPlugins) {
    merged.enabledPlugins = {
      ...(base.enabledPlugins ?? {}),
      ...additions.enabledPlugins,
    };
  }

  // Carry through any other top-level keys the caller passed (rare, but
  // keeps the function future-proof).
  for (const [k, v] of Object.entries(additions)) {
    if (k === "extraKnownMarketplaces" || k === "enabledPlugins") continue;
    merged[k] = v;
  }

  return merged;
}

/** Write atomically: tmp file + rename. */
export function writeSettings(
  settings: ClaudeSettings,
  path: string = defaultSettingsPath(),
): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/** End-to-end helper: read → merge → write. The function the CLI calls. */
export function mergeAndWriteSettings(
  additions: ClaudeSettings,
  path: string = defaultSettingsPath(),
): ClaudeSettings {
  const existing = readSettings(path);
  const merged = mergeSettings(existing, additions);
  writeSettings(merged, path);
  return merged;
}

/** Build the additions object for a given client + plugin list. */
export function buildClientSettings(args: {
  marketplaceName: string;
  marketplaceUrl: string;
  pluginNames: string[];
}): ClaudeSettings {
  const enabledPlugins: Record<string, boolean> = {};
  for (const plugin of args.pluginNames) {
    enabledPlugins[`${plugin}@${args.marketplaceName}`] = true;
  }
  return {
    extraKnownMarketplaces: {
      [args.marketplaceName]: {
        source: { source: "url", url: args.marketplaceUrl },
      },
    },
    enabledPlugins,
  };
}
