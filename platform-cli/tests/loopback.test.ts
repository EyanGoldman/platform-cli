import { describe, expect, it } from "vitest";
import { startLoopback } from "../src/loopback.js";

describe("startLoopback", () => {
  it("captures the platform_token from /callback and resolves", async () => {
    const handle = await startLoopback({ timeoutMs: 5_000 });
    const callback = `${handle.url}?platform_token=jwt-abc`;
    const tokenP = handle.waitForToken();
    const res = await fetch(callback);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("signed in");
    expect(await tokenP).toBe("jwt-abc");
  });

  it("returns 400 + rejects when no token query param is present", async () => {
    const handle = await startLoopback({ timeoutMs: 5_000 });
    // Attach the rejection handler before triggering the request to
    // avoid an UnhandledRejection warning in vitest.
    const tokenP = handle.waitForToken().catch((err) => err);
    const res = await fetch(handle.url);
    expect(res.status).toBe(400);
    const err = await tokenP;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/platform_token/);
    handle.close();
  });

  it("returns 404 for paths other than /callback", async () => {
    const handle = await startLoopback({ timeoutMs: 5_000 });
    const url = new URL(handle.url);
    const res = await fetch(`http://${url.host}/nope`);
    expect(res.status).toBe(404);
    handle.close();
  });

  it("times out cleanly", async () => {
    const handle = await startLoopback({ timeoutMs: 50 });
    await expect(handle.waitForToken()).rejects.toThrow(/Timed out/);
  });
});
