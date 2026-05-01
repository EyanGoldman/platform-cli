/**
 * `platform refresh` — re-mint the developer git token.
 *
 * Same SSO loop as `login`, minus settings.json + claude plugin
 * commands. Writes the new token over the keychain entry and
 * `~/.platform/env`. Existing settings + git config are untouched.
 */

import { hostname } from "node:os";
import { resolveConfig } from "../config.js";
import { startLoopback } from "../loopback.js";
import { getBrowserOpener } from "../browser.js";
import { issueGitToken, joinUrl } from "../platform-api.js";
import {
  getKeychain,
  KEYCHAIN_ACCOUNT_EXPIRES,
  KEYCHAIN_ACCOUNT_TOKEN,
  KEYCHAIN_SERVICE,
} from "../keychain.js";
import { writePlatformEnv } from "../shell-integration.js";

export async function runRefresh(args: string[]): Promise<number> {
  const opts = parseArgs(args);
  const config = resolveConfig();
  const log = (line: string) => process.stdout.write(`${line}\n`);

  log("Refreshing your platform token (signs you in via the browser)…");
  const loopback = await startLoopback();
  const startUrl = `${joinUrl(config.appStoreUrl, "/api/v1/auth/dev-token-redirect")}?redirect_uri=${encodeURIComponent(loopback.url)}`;
  log(`If a browser doesn't open, paste: ${startUrl}`);
  getBrowserOpener().open(startUrl);

  let platformToken: string;
  try {
    platformToken = await loopback.waitForToken();
  } catch (err) {
    loopback.close();
    throw err;
  }

  const machineLabel = opts.name ?? hostname() ?? "unnamed-machine";
  const issued = await issueGitToken({
    apiGatewayUrl: config.apiGatewayUrl,
    platformToken,
    name: machineLabel,
  });

  const keychain = getKeychain();
  keychain.setSecret(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT_TOKEN, issued.plaintext);
  keychain.setSecret(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT_EXPIRES, issued.expiresAt);
  writePlatformEnv(issued.plaintext);

  log(`✓ Token refreshed (expires ${issued.expiresAt}). Open a new terminal to pick up the new \`PLATFORM_NPM_TOKEN\`.`);
  return 0;
}

function parseArgs(args: string[]): { name?: string } {
  const out: { name?: string } = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--name" && args[i + 1]) {
      out.name = args[i + 1];
      i++;
    }
  }
  return out;
}
