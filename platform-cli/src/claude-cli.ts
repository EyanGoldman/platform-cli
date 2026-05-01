/**
 * Drive the local `claude` CLI to register the marketplace + install
 * each plugin. The empirical test recorded in the plan
 * (sub-task 4 brief) is decisive: settings.json pre-registration alone
 * does NOT auto-load the marketplace; we MUST run these commands after
 * writing settings.json.
 *
 *   claude plugin marketplace add url:<url>
 *   claude plugin install <plugin>@<marketplace>   (per plugin)
 *
 * We surface failures clearly because a half-installed marketplace is
 * worse than a clean error — at least the user can re-run.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface ClaudeCli {
  marketplaceAdd(url: string): Promise<void>;
  pluginInstall(plugin: string, marketplaceName: string): Promise<void>;
  isAvailable(): Promise<boolean>;
}

class DefaultClaudeCli implements ClaudeCli {
  async marketplaceAdd(url: string): Promise<void> {
    // The CLI accepts a bare URL/path/owner-repo as the source argument.
    // The earlier `url:<url>` form is rejected by current `claude` versions.
    await execFileP("claude", ["plugin", "marketplace", "add", url], {
      timeout: 30_000,
    });
  }

  async pluginInstall(plugin: string, marketplaceName: string): Promise<void> {
    await execFileP("claude", ["plugin", "install", `${plugin}@${marketplaceName}`], {
      timeout: 60_000,
    });
  }

  async isAvailable(): Promise<boolean> {
    try {
      await execFileP("claude", ["--version"], { timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  }
}

let cli: ClaudeCli = new DefaultClaudeCli();

export function getClaudeCli(): ClaudeCli {
  return cli;
}

export function setClaudeCli(c: ClaudeCli): void {
  cli = c;
}

export function resetClaudeCli(): void {
  cli = new DefaultClaudeCli();
}
