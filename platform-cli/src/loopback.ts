/**
 * Tiny localhost HTTP listener that captures the `platform_token` query
 * param dropped by `dev-token-redirect`.
 *
 * Flow:
 *   1. `start()` returns a `{ url, waitForToken }` pair. The caller
 *      opens `url` in the browser; the SSO flow eventually 302s to it.
 *   2. The first request to `/callback?platform_token=…` resolves the
 *      promise. Other paths get a 404. After resolving, the server is
 *      shut down on the next tick so the user sees the success page.
 *   3. A timeout (default 5 minutes) rejects with a friendly message.
 *
 * We bind to `127.0.0.1` (not `0.0.0.0`) so the listener never accepts
 * connections from outside the machine — this is short-lived but it'd
 * still be embarrassing to leak a JWT to anyone on the LAN.
 */

import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";

export interface LoopbackHandle {
  /** The fully-qualified callback URL — this is what you embed in the
   * `redirect_uri` query param when starting SSO. */
  url: string;
  /** Resolves with the captured JWT, or rejects on timeout / abort. */
  waitForToken(): Promise<string>;
  /** Shut down the server early (e.g. user-cancelled). Idempotent. */
  close(): void;
}

export interface LoopbackOptions {
  /** Override timeout in ms. Default 5 minutes. */
  timeoutMs?: number;
  /** Override path. Default `/callback`. */
  path?: string;
  /** Override port. Default `0` (random). */
  port?: number;
  /** HTML body for the "you can close this tab" page. Defaults to a
   * minimal styled page so the dev sees a confirmation. */
  successHtml?: string;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_PATH = "/callback";

const DEFAULT_SUCCESS_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Platform CLI — signed in</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#111;}
h1{font-size:1.25rem;margin:0 0 .5rem;} p{color:#444;}</style>
</head><body>
<h1>You're signed in.</h1>
<p>You can close this tab and return to the terminal.</p>
</body></html>`;

export async function startLoopback(options: LoopbackOptions = {}): Promise<LoopbackHandle> {
  const path = options.path ?? DEFAULT_PATH;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const port = options.port ?? 0;
  const successHtml = options.successHtml ?? DEFAULT_SUCCESS_HTML;

  let server: Server;
  let resolveToken!: (jwt: string) => void;
  let rejectToken!: (err: Error) => void;
  let settled = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  const tokenPromise = new Promise<string>((resolve, reject) => {
    resolveToken = (jwt) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      resolve(jwt);
    };
    rejectToken = (err) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      reject(err);
    };
  });

  await new Promise<void>((resolve, reject) => {
    server = createServer((req, res) => {
      try {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (url.pathname !== path) {
          res.statusCode = 404;
          res.end();
          return;
        }
        const jwt = url.searchParams.get("platform_token");
        if (!jwt) {
          res.statusCode = 400;
          res.setHeader("content-type", "text/plain; charset=utf-8");
          res.end("Missing platform_token query param");
          rejectToken(new Error("Callback received without platform_token"));
          return;
        }
        res.statusCode = 200;
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(successHtml);
        resolveToken(jwt);
        // Defer close so the response actually flushes.
        setImmediate(() => server.close());
      } catch (err) {
        res.statusCode = 500;
        res.end();
        rejectToken(err instanceof Error ? err : new Error(String(err)));
      }
    });
    server.on("error", (err) => {
      rejectToken(err);
      reject(err);
    });
    server.listen(port, "127.0.0.1", () => resolve());
  });

  const address = server!.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}${path}`;

  timeoutHandle = setTimeout(() => {
    rejectToken(
      new Error(
        "Timed out waiting for SSO callback. Re-run `platform login` and complete the browser flow within 5 minutes.",
      ),
    );
    server!.close();
  }, timeoutMs);

  return {
    url,
    waitForToken: () => tokenPromise,
    close: () => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      server!.close();
    },
  };
}
