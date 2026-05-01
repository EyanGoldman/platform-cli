/**
 * Resolve platform endpoints from the environment.
 *
 * `PLATFORM_PROXY_BASE_URL` is the public-facing proxy host. The
 * git-credential-helper config keys off the parsed host of this URL.
 * It's REQUIRED — there is no sensible default. The bootstrap installer
 * sets it (the install route serves install.sh with the host baked in),
 * platform contributors set it locally via shell rc, and CI sets it
 * per-environment.
 *
 * `APP_STORE_URL` and `API_GATEWAY_URL` are the SSO origin (where the
 * dev-token-redirect lives) and the gateway origin (where /dev/git-token
 * lives). In production, both are typically reverse-proxied under the
 * same `PLATFORM_PROXY_BASE_URL`. In local dev they're three different
 * localhost ports, hence the override knobs.
 */

export interface PlatformConfig {
  proxyBaseUrl: string;
  appStoreUrl: string;
  apiGatewayUrl: string;
}

export class MissingPlatformProxyBaseUrlError extends Error {
  constructor() {
    super(
      "PLATFORM_PROXY_BASE_URL is not set. Run `platform login` (or re-run the bootstrap installer) — it sets this in your shell rc. If you're a platform contributor, set it manually to your local api-gateway URL (e.g. http://localhost:3002).",
    );
    this.name = "MissingPlatformProxyBaseUrlError";
  }
}

export function resolveConfig(env: NodeJS.ProcessEnv = process.env): PlatformConfig {
  const raw = env.PLATFORM_PROXY_BASE_URL;
  if (!raw || raw.length === 0) {
    throw new MissingPlatformProxyBaseUrlError();
  }
  const proxyBaseUrl = trimTrailingSlash(raw);
  const appStoreUrl = trimTrailingSlash(env.APP_STORE_URL ?? proxyBaseUrl);
  const apiGatewayUrl = trimTrailingSlash(env.API_GATEWAY_URL ?? proxyBaseUrl);
  return { proxyBaseUrl, appStoreUrl, apiGatewayUrl };
}

/** Extract the host (no port) from a URL. Used by the git config key. */
export function urlHost(url: string): string {
  return new URL(url).host;
}

function trimTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}
