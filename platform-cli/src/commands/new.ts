/**
 * `platform new <slug>` — start a new app from the platform scaffold.
 *
 *   git clone <PLATFORM_PROXY>/api/v1/git/scaffold <slug>
 *   cd <slug> && pnpm install
 *   git remote rename origin platform-scaffold
 *
 * The credential helper supplies the dev token automatically — the
 * dev never sees a credential.
 *
 * Validates the slug against a conservative regex (lowercase letters,
 * digits, hyphens; 2–48 chars). Same shape as `Client.slug` to keep
 * cross-references unambiguous.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { joinUrl } from "../platform-api.js";
import { resolveConfig } from "../config.js";
import { runCmd } from "../runners.js";

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;

export async function runNew(args: string[]): Promise<number> {
  const slug = args[0];
  if (!slug) {
    process.stderr.write("Usage: platform new <app-slug>\n");
    return 64;
  }
  if (!SLUG_RE.test(slug)) {
    process.stderr.write(
      "✗ Invalid app slug. Use 2–48 lowercase letters, numbers, and hyphens.\n",
    );
    return 64;
  }
  const target = resolve(process.cwd(), slug);
  if (existsSync(target)) {
    process.stderr.write(`✗ Directory '${slug}' already exists. Pick a different name.\n`);
    return 1;
  }

  const log = (line: string) => process.stdout.write(`${line}\n`);
  const config = resolveConfig();
  const scaffoldUrl = joinUrl(config.proxyBaseUrl, "/api/v1/git/scaffold");

  log(`Cloning the platform scaffold into ./${slug}…`);
  await runCmd("git", ["clone", scaffoldUrl, slug], {
    cwd: process.cwd(),
    timeout: 120_000,
  });

  log("Installing dependencies (this can take a minute)…");
  await runCmd("pnpm", ["install"], {
    cwd: target,
    timeout: 300_000,
  });

  log("Renaming remote…");
  await runCmd("git", ["remote", "rename", "origin", "platform-scaffold"], {
    cwd: target,
    timeout: 5_000,
  });

  log("");
  log(`✓ App '${slug}' ready. cd ${slug} and tell Claude what to build.`);
  return 0;
}
