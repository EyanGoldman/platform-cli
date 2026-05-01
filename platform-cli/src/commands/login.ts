/**
 * `platform login` — the one command bootstrap.
 *
 * Order of operations is load-bearing:
 *
 *   1. Loopback server up before browser opens (else SSO 302 races us).
 *   2. JWT received → exchange for DeveloperGitToken before writing
 *      anything to disk (a failed exchange shouldn't leave a
 *      half-configured machine).
 *   3. Token in keychain BEFORE writing ~/.platform/env (env file is
 *      a denormalised cache; keychain is the source of truth).
 *   4. Settings merge BEFORE running claude — the empirical test says
 *      `claude plugin install` is what actually loads the plugin, but
 *      having settings.json correctly pre-merged means a future `claude`
 *      version that does honour pre-registration still works.
 *   5. `claude plugin marketplace add` then `claude plugin install` per
 *      plugin. Per the empirical test, BOTH steps are required —
 *      `enabledPlugins` is an enable/disable flag, not an install
 *      directive.
 */

import { hostname } from "node:os";
import { resolveConfig, urlHost } from "../config.js";
import { startLoopback } from "../loopback.js";
import { getBrowserOpener } from "../browser.js";
import { decodeClientSlug, fetchDevSkills, issueGitToken, joinUrl } from "../platform-api.js";
import {
  getKeychain,
  KEYCHAIN_ACCOUNT_EXPIRES,
  KEYCHAIN_ACCOUNT_TOKEN,
  KEYCHAIN_SERVICE,
} from "../keychain.js";
import { ensureShellRcSourcesEnv, writePlatformEnv } from "../shell-integration.js";
import {
  configureGitCredentialHelper,
  defaultHelperPath,
  helperBinaryExists,
} from "../git-helper.js";
import { buildClientSettings, mergeAndWriteSettings } from "../settings.js";
import { getClaudeCli } from "../claude-cli.js";

export interface LoginOptions {
  /** Override the machine label sent to /dev/git-token. Defaults to
   * the OS hostname, which is what the user will recognise in the
   * IT admin token-list UI. */
  name?: string;
  /** Skip the `claude plugin` invocation step. Used by tests +
   * advanced users who want to defer marketplace registration. */
  skipClaudeInstall?: boolean;
}

export async function runLogin(args: string[], options: LoginOptions = {}): Promise<number> {
  const opts = parseArgs(args, options);
  const config = resolveConfig();

  const log = (line: string) => process.stdout.write(`${line}\n`);

  log("Opening your browser to sign in to the platform…");

  // 1. Loopback first.
  const loopback = await startLoopback();

  // 2. Compose the redirect URL and open the browser.
  const startUrl = `${joinUrl(config.appStoreUrl, "/api/v1/auth/dev-token-redirect")}?redirect_uri=${encodeURIComponent(loopback.url)}`;
  log(`If a browser doesn't open, paste this URL: ${startUrl}`);
  getBrowserOpener().open(startUrl);

  // 3. Wait for the JWT.
  let platformToken: string;
  try {
    platformToken = await loopback.waitForToken();
  } catch (err) {
    loopback.close();
    throw err;
  }
  log("✓ Signed in");

  // 4. Exchange JWT for a DeveloperGitToken.
  const machineLabel = opts.name ?? hostname() ?? "unnamed-machine";
  const issued = await issueGitToken({
    apiGatewayUrl: config.apiGatewayUrl,
    platformToken,
    name: machineLabel,
  });
  log(`✓ Minted developer token (${machineLabel})`);

  // 5. Keychain.
  const keychain = getKeychain();
  keychain.setSecret(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT_TOKEN, issued.plaintext);
  keychain.setSecret(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT_EXPIRES, issued.expiresAt);

  // 6. ~/.platform/env + shell rc.
  const envPath = writePlatformEnv(issued.plaintext);
  const editedRcs = ensureShellRcSourcesEnv();
  log(`✓ Wrote ${envPath}`);
  if (editedRcs.length > 0) {
    log(
      `  Sourced from ${editedRcs.join(", ")} (open a new terminal or run \`source ~/.platform/env\`).`,
    );
  }

  // 7. Git credential helper.
  const helperPath = defaultHelperPath();
  configureGitCredentialHelper({
    host: urlHost(config.proxyBaseUrl),
    helperPath,
  });
  log(`✓ Configured git credential helper for ${urlHost(config.proxyBaseUrl)}`);
  if (!helperBinaryExists(helperPath)) {
    log(
      `  Note: helper binary not yet installed at ${helperPath}. The bootstrap installer places it there; if you're a developer working on the CLI, build it from \`tools/platform-cred-helper\`.`,
    );
  }

  // 8. Resolve marketplace name + plugin list.
  const clientSlug = decodeClientSlug(platformToken) ?? "platform";
  const skills = await fetchDevSkills({
    apiGatewayUrl: config.apiGatewayUrl,
    platformToken,
    clientSlug,
  });
  // Append `.git` so `claude plugin marketplace add` (and any future
  // `update`) takes the git-clone code path rather than trying to
  // download a single marketplace.json. The proxy strips `.git` when
  // resolving the resource, so both forms work upstream.
  const marketplaceUrl = `${joinUrl(config.proxyBaseUrl, "/api/v1/git/marketplace")}.git`;

  // 9. Merge settings.json.
  const settings = buildClientSettings({
    marketplaceName: skills.marketplaceName,
    marketplaceUrl,
    pluginNames: skills.plugins.map((p) => p.name),
  });
  mergeAndWriteSettings(settings);
  log(`✓ Updated ~/.claude/settings.json (${skills.plugins.length} plugins enabled)`);

  // 10. Run `claude plugin marketplace add` + `claude plugin install`.
  if (!opts.skipClaudeInstall) {
    const claude = getClaudeCli();
    if (!(await claude.isAvailable())) {
      log(
        "⚠ `claude` CLI not found on PATH. Install Claude Code, then run `platform login` again.",
      );
      return 0;
    }
    try {
      await claude.marketplaceAdd(marketplaceUrl);
      log(`✓ Registered marketplace ${skills.marketplaceName} with Claude Code`);
    } catch (err) {
      throw new Error(
        `Failed to register marketplace with Claude Code. The token + settings are in place; rerun \`platform login\` once the issue is fixed.\n  underlying: ${describeErr(err)}`,
      );
    }
    for (const plugin of skills.plugins) {
      try {
        await claude.pluginInstall(plugin.name, skills.marketplaceName);
      } catch (err) {
        throw new Error(
          `Failed to install plugin '${plugin.name}'. Rerun \`platform login\` to retry, or run \`claude plugin install ${plugin.name}@${skills.marketplaceName}\` manually.\n  underlying: ${describeErr(err)}`,
        );
      }
    }
    log(`✓ Installed ${skills.plugins.length} plugins`);
  }

  log("");
  log("✓ Ready. Open Claude Code and tell it what to build.");
  return 0;
}

function parseArgs(args: string[], base: LoginOptions): LoginOptions {
  const merged: LoginOptions = { ...base };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--name" && args[i + 1]) {
      merged.name = args[i + 1];
      i++;
    } else if (a === "--skip-claude-install") {
      merged.skipClaudeInstall = true;
    }
  }
  return merged;
}

function describeErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
