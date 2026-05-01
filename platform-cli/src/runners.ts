/**
 * Tiny abstraction over `child_process.execFile` so tests can mock
 * the runner without fighting `util.promisify`'s custom-symbol
 * machinery. Used by `platform doctor` for the version-check probes.
 */

import { execFile } from "node:child_process";

export interface RunOptions {
  timeout?: number;
  cwd?: string;
}

export interface RunResult {
  stdout: string;
  stderr: string;
}

class DefaultRunner {
  run(file: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      execFile(file, args, options, (err, stdout: string | Buffer, stderr: string | Buffer) => {
        if (err) {
          reject(err);
          return;
        }
        resolve({
          stdout: typeof stdout === "string" ? stdout : stdout.toString("utf8"),
          stderr: typeof stderr === "string" ? stderr : stderr.toString("utf8"),
        });
      });
    });
  }
}

let runner: { run: DefaultRunner["run"] } = new DefaultRunner();

export function runCmd(file: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return runner.run(file, args, options);
}

export function setRunner(fn: (file: string, args: string[], options: RunOptions) => Promise<RunResult>): void {
  runner = { run: fn };
}

export function resetRunner(): void {
  runner = new DefaultRunner();
}
