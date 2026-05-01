/**
 * Thin HTTP client for the platform endpoints the CLI calls.
 *
 * Two endpoints today:
 *   - `POST /api/v1/dev/git-token`      — issue a DeveloperGitToken
 *   - `GET  /api/v1/dev/skills`         — fetch the marketplace name +
 *                                          plugin list for the caller's
 *                                          client. Falls back to a
 *                                          hardcoded platform-default
 *                                          if the endpoint 404s, so a
 *                                          mismatched gateway version
 *                                          doesn't brick `platform login`.
 */

/* The platform-default plugin list. Mirrors PLATFORM_PLUGIN_TYPES in
 * apps/api-gateway/src/lib/provisioning/marketplace.ts. The CLI uses
 * this only when the gateway has no /dev/skills endpoint. */
export const PLATFORM_DEFAULT_PLUGINS = [
  "core",
  "deployment",
  "debugging",
  "design-system",
  "platform-dev",
  "getting-started",
  "api-integration",
  "sso-user-context",
  "platform-services",
  "security",
  "app-retrieval",
] as const;

export interface IssueGitTokenResponse {
  id: string;
  name: string;
  plaintext: string;
  expiresAt: string;
}

export interface DevSkillsResponse {
  marketplaceName: string;
  plugins: Array<{ name: string }>;
}

export class PlatformApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
  ) {
    super(message);
    this.name = "PlatformApiError";
  }
}

/**
 * Issue a developer git token. The platform-token JWT in the
 * Authorization header authenticates the caller; the gateway resolves
 * the user/client from the JWT.
 */
export async function issueGitToken(args: {
  apiGatewayUrl: string;
  platformToken: string;
  name: string;
  fetchImpl?: typeof fetch;
}): Promise<IssueGitTokenResponse> {
  const fetchFn = args.fetchImpl ?? fetch;
  const url = joinUrl(args.apiGatewayUrl, "/api/v1/dev/git-token");
  const res = await fetchFn(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.platformToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ name: args.name }),
  });

  if (!res.ok) {
    const body = await safeReadText(res);
    throw new PlatformApiError(
      `Failed to issue developer git token (${res.status}). The proxy is up but it didn't accept the request — try \`platform login\` again.`,
      res.status,
      body,
    );
  }

  const json = (await res.json()) as { data?: IssueGitTokenResponse } | IssueGitTokenResponse;
  // The gateway wraps responses in { data: ... }. Tolerate both for
  // tests + future shape changes.
  const payload =
    "data" in (json as Record<string, unknown>)
      ? ((json as { data: IssueGitTokenResponse }).data)
      : (json as IssueGitTokenResponse);

  if (
    !payload ||
    typeof payload.id !== "string" ||
    typeof payload.plaintext !== "string" ||
    typeof payload.expiresAt !== "string"
  ) {
    throw new PlatformApiError(
      "Token endpoint returned an unexpected shape.",
      res.status,
      JSON.stringify(json),
    );
  }
  return payload;
}

/**
 * Fetch the marketplace name + plugin list. If the endpoint isn't
 * implemented yet (404), return a fallback derived from the caller's
 * client slug + platform defaults. The caller can pass an override via
 * the `clientSlug` arg so the fallback still produces the right
 * marketplace name.
 */
export async function fetchDevSkills(args: {
  apiGatewayUrl: string;
  platformToken: string;
  clientSlug: string;
  fetchImpl?: typeof fetch;
}): Promise<DevSkillsResponse> {
  const fetchFn = args.fetchImpl ?? fetch;
  const url = joinUrl(args.apiGatewayUrl, "/api/v1/dev/skills");
  let res: Response;
  try {
    res = await fetchFn(url, {
      headers: {
        Authorization: `Bearer ${args.platformToken}`,
        Accept: "application/json",
      },
    });
  } catch (err) {
    return platformDefaults(args.clientSlug, err);
  }
  if (res.status === 404) {
    return platformDefaults(args.clientSlug);
  }
  if (!res.ok) {
    throw new PlatformApiError(
      `Failed to fetch dev skills (${res.status}).`,
      res.status,
      await safeReadText(res),
    );
  }
  const json = (await res.json()) as { data?: DevSkillsResponse } | DevSkillsResponse;
  const payload =
    "data" in (json as Record<string, unknown>)
      ? ((json as { data: DevSkillsResponse }).data)
      : (json as DevSkillsResponse);
  if (!payload || typeof payload.marketplaceName !== "string" || !Array.isArray(payload.plugins)) {
    return platformDefaults(args.clientSlug);
  }
  return payload;
}

function platformDefaults(clientSlug: string, _cause?: unknown): DevSkillsResponse {
  return {
    marketplaceName: `client-${clientSlug}`,
    plugins: PLATFORM_DEFAULT_PLUGINS.map((name) => ({ name })),
  };
}

/* ───────────────────────────── helpers ───────────────────────────── */

export function joinUrl(base: string, path: string): string {
  const trimmedBase = base.replace(/\/+$/, "");
  const trimmedPath = path.startsWith("/") ? path : `/${path}`;
  return `${trimmedBase}${trimmedPath}`;
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/**
 * Decode the `clientSlug` claim out of a platform JWT without verifying
 * the signature. We don't need verification here — the gateway is the
 * one that verifies on every API call. The CLI only needs the slug for
 * UX (marketplace name).
 *
 * Returns null on any malformed input. Resilient: a missing claim is
 * fine, the CLI prompts the user to pick a name.
 */
export function decodeClientSlug(jwt: string): string | null {
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = parts[1];
    if (!payload) return null;
    const json = Buffer.from(payload, "base64url").toString("utf8");
    const claims = JSON.parse(json) as { clientSlug?: unknown };
    return typeof claims.clientSlug === "string" ? claims.clientSlug : null;
  } catch {
    return null;
  }
}
