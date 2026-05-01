/**
 * `platform` — bootstrap CLI.
 *
 * Subcommands:
 *   platform login                — full bootstrap (browser SSO → token
 *                                   → keychain → settings → claude
 *                                   plugin install)
 *   platform doctor               — diagnostic checklist
 *   platform refresh              — re-mint the developer git token
 *   platform new <slug>           — clone the platform scaffold for a
 *                                   new app
 *
 * The user is non-technical (Excel-fluent, not architecture-fluent), so
 * every error message must be a single sentence followed by a single
 * actionable next step. No stack traces unless `--debug`.
 */

import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { runLogin } from "./commands/login.js";
import { runDoctor } from "./commands/doctor.js";
import { runRefresh } from "./commands/refresh.js";
import { runNew } from "./commands/new.js";

const VERSION = "0.1.0";

function printHelp(): void {
  process.stdout.write(
    [
      `platform ${VERSION}`,
      "",
      "Usage:",
      "  platform login            Bootstrap this machine for the platform",
      "  platform doctor           Diagnose problems",
      "  platform refresh          Re-mint your platform token",
      "  platform new <slug>       Start a new app",
      "  platform --version        Print version",
      "  platform --help           Show this help",
      "",
    ].join("\n"),
  );
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const cmd = argv[0];

  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    printHelp();
    return 0;
  }
  if (cmd === "--version" || cmd === "-v" || cmd === "version") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  try {
    switch (cmd) {
      case "login":
        return await runLogin(argv.slice(1));
      case "doctor":
        return await runDoctor(argv.slice(1));
      case "refresh":
        return await runRefresh(argv.slice(1));
      case "new":
        return await runNew(argv.slice(1));
      default:
        process.stderr.write(`Unknown command: ${cmd}\n\n`);
        printHelp();
        return 64;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`✗ ${message}\n`);
    if (process.env.PLATFORM_CLI_DEBUG) {
      process.stderr.write(`${err instanceof Error && err.stack ? err.stack : ""}\n`);
    }
    return 1;
  }
}

// Run when invoked as a CLI; do nothing when imported by tests. We
// don't constrain by package-dir name because the install script
// renames the unpacked tarball directory, which broke an earlier
// regex that matched literal `platform-cli/`. Match by file shape
// (`<dir>/index.[mc]?[jt]s`) and resolve symlinks for `bin/platform`.
function isDirectInvocation(): boolean {
  if (typeof process === "undefined" || !process.argv[1]) return false;
  const argv1 = process.argv[1];
  // Bare `node <anything>/dist/index.js` or `node <anything>/src/index.ts`.
  if (/(?:^|[\\/])(?:dist|src)[\\/]index\.[cm]?[jt]s$/.test(argv1)) {
    return true;
  }
  // Compare argv[1] (possibly a symlink, e.g. `bin/platform`) against
  // this module's resolved path. realpath both sides; if equal, this
  // is the entry point.
  try {
    const meta = fileURLToPath(import.meta.url);
    return realpathSync(argv1) === realpathSync(meta);
  } catch {
    return false;
  }
}
if (isDirectInvocation()) {
  void main().then((code) => process.exit(code));
}
