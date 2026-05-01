import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setRunner, resetRunner } from "../src/runners.js";
import { runNew } from "../src/commands/new.js";

let cwd: string;
let originalCwd: string;
let originalErrWrite: typeof process.stderr.write;
let stderr: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "platform-cli-new-"));
  originalCwd = process.cwd();
  process.chdir(cwd);
  process.env.PLATFORM_PROXY_BASE_URL = "https://platform.test";

  stderr = "";
  originalErrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

  calls = [];
  setRunner(async (file, args, options) => {
    calls.push({ file, args, options });
    return { stdout: "", stderr: "" };
  });
});

let calls: Array<{ file: string; args: string[]; options: { cwd?: string; timeout?: number } }>;

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(cwd, { recursive: true, force: true });
  process.stderr.write = originalErrWrite;
  resetRunner();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  delete process.env.PLATFORM_PROXY_BASE_URL;
});

describe("runNew", () => {
  it("rejects an invalid slug", async () => {
    const code = await runNew(["BADSLUG"]);
    expect(code).toBe(64);
    expect(stderr).toContain("Invalid app slug");
  });

  it("rejects when missing slug", async () => {
    const code = await runNew([]);
    expect(code).toBe(64);
  });

  it("rejects when target dir already exists", async () => {
    mkdirSync(join(cwd, "my-app"));
    const code = await runNew(["my-app"]);
    expect(code).toBe(1);
    expect(stderr).toContain("already exists");
  });

  it("happy path: clones, installs, renames remote", async () => {
    const code = await runNew(["my-app"]);
    expect(code).toBe(0);

    // 1. git clone
    expect(calls[0]?.file).toBe("git");
    expect(calls[0]?.args[0]).toBe("clone");
    expect(calls[0]?.args[1]).toBe("https://platform.test/api/v1/git/scaffold");
    expect(calls[0]?.args[2]).toBe("my-app");
    // 2. pnpm install
    expect(calls[1]?.file).toBe("pnpm");
    expect(calls[1]?.args[0]).toBe("install");
    // 3. git remote rename
    expect(calls[2]?.file).toBe("git");
    expect(calls[2]?.args.slice(0, 4)).toEqual(["remote", "rename", "origin", "platform-scaffold"]);
  });
});
