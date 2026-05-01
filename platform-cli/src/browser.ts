/**
 * Open the user's default browser to the SSO start URL.
 *
 * Cross-platform: `open` on macOS, `start` on Windows, `xdg-open` on
 * Linux. We pick the right one without taking a dependency on `open`
 * since it's a 35MB tree of indirection for a one-line task.
 *
 * If launching fails (no GUI, headless box), we don't crash — we just
 * print the URL and let the user paste it themselves.
 */

import { spawn } from "node:child_process";

export interface BrowserOpener {
  open(url: string): void;
}

class DefaultBrowserOpener implements BrowserOpener {
  open(url: string): void {
    let cmd: string;
    let args: string[];
    switch (process.platform) {
      case "darwin":
        cmd = "open";
        args = [url];
        break;
      case "win32":
        // `start` is a cmd.exe builtin, so we have to invoke it through
        // cmd.exe. The empty quoted "" is the title arg `start` needs
        // when the URL contains spaces.
        cmd = "cmd";
        args = ["/c", "start", "", url];
        break;
      default:
        cmd = "xdg-open";
        args = [url];
    }
    try {
      const child = spawn(cmd, args, { stdio: "ignore", detached: true });
      child.on("error", () => {
        /* swallow — caller decides how to surface this */
      });
      child.unref();
    } catch {
      /* swallow */
    }
  }
}

let opener: BrowserOpener = new DefaultBrowserOpener();

export function getBrowserOpener(): BrowserOpener {
  return opener;
}

/** Test seam — replace the default opener. */
export function setBrowserOpener(o: BrowserOpener): void {
  opener = o;
}

export function resetBrowserOpener(): void {
  opener = new DefaultBrowserOpener();
}
