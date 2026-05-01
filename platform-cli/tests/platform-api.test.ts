import { describe, expect, it, vi } from "vitest";
import {
  decodeClientSlug,
  fetchDevSkills,
  issueGitToken,
  joinUrl,
  PlatformApiError,
  PLATFORM_DEFAULT_PLUGINS,
} from "../src/platform-api.js";

describe("joinUrl", () => {
  it("joins with a single slash regardless of trailing/leading slashes", () => {
    expect(joinUrl("https://x.com", "/api")).toBe("https://x.com/api");
    expect(joinUrl("https://x.com/", "/api")).toBe("https://x.com/api");
    expect(joinUrl("https://x.com/", "api")).toBe("https://x.com/api");
    expect(joinUrl("https://x.com//", "//api")).toBe("https://x.com//api");
  });
});

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

describe("issueGitToken", () => {
  it("posts JSON with bearer auth and returns the data envelope", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          data: {
            id: "tok_123",
            name: "my-laptop",
            plaintext: "dgt_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            expiresAt: "2026-12-01T00:00:00.000Z",
          },
        },
        { status: 201 },
      ),
    );

    const result = await issueGitToken({
      apiGatewayUrl: "https://gw.example",
      platformToken: "jwt-abc",
      name: "my-laptop",
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://gw.example/api/v1/dev/git-token");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer jwt-abc",
      "Content-Type": "application/json",
    });
    expect((init as RequestInit).body).toBe('{"name":"my-laptop"}');
    expect(result.id).toBe("tok_123");
    expect(result.plaintext).toMatch(/^dgt_/);
  });

  it("accepts an unwrapped (non-data-envelope) response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        id: "tok_a",
        name: "x",
        plaintext: "dgt_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
        expiresAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    const r = await issueGitToken({
      apiGatewayUrl: "https://gw",
      platformToken: "jwt",
      name: "x",
      fetchImpl,
    });
    expect(r.id).toBe("tok_a");
  });

  it("throws PlatformApiError on non-2xx", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response("nope", { status: 401 }),
    );
    await expect(
      issueGitToken({ apiGatewayUrl: "https://gw", platformToken: "jwt", name: "x", fetchImpl }),
    ).rejects.toThrow(PlatformApiError);
  });

  it("throws on shape mismatch", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ data: { id: 1 } }));
    await expect(
      issueGitToken({ apiGatewayUrl: "https://gw", platformToken: "jwt", name: "x", fetchImpl }),
    ).rejects.toThrow(PlatformApiError);
  });
});

describe("fetchDevSkills", () => {
  it("returns the data envelope when the endpoint exists", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        data: {
          marketplaceName: "client-acme",
          plugins: [{ name: "core" }, { name: "deployment" }],
        },
      }),
    );
    const r = await fetchDevSkills({
      apiGatewayUrl: "https://gw",
      platformToken: "jwt",
      clientSlug: "acme",
      fetchImpl,
    });
    expect(r.marketplaceName).toBe("client-acme");
    expect(r.plugins).toHaveLength(2);
  });

  it("falls back to platform defaults on 404", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("", { status: 404 }));
    const r = await fetchDevSkills({
      apiGatewayUrl: "https://gw",
      platformToken: "jwt",
      clientSlug: "acme",
      fetchImpl,
    });
    expect(r.marketplaceName).toBe("client-acme");
    expect(r.plugins.map((p) => p.name)).toEqual([...PLATFORM_DEFAULT_PLUGINS]);
  });

  it("falls back on network error", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const r = await fetchDevSkills({
      apiGatewayUrl: "https://gw",
      platformToken: "jwt",
      clientSlug: "x",
      fetchImpl,
    });
    expect(r.marketplaceName).toBe("client-x");
    expect(r.plugins.length).toBeGreaterThan(0);
  });
});

describe("decodeClientSlug", () => {
  it("returns the clientSlug claim from a JWT", () => {
    const claims = { id: "u1", clientSlug: "acme", roles: [] };
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const jwt = `header.${payload}.signature`;
    expect(decodeClientSlug(jwt)).toBe("acme");
  });

  it("returns null for malformed input", () => {
    expect(decodeClientSlug("not-a-jwt")).toBeNull();
    expect(decodeClientSlug("a.b")).toBeNull();
    expect(decodeClientSlug("a.notbase64.b")).toBeNull();
  });

  it("returns null when claim is absent", () => {
    const payload = Buffer.from(JSON.stringify({ id: "u1" })).toString("base64url");
    expect(decodeClientSlug(`h.${payload}.s`)).toBeNull();
  });
});
