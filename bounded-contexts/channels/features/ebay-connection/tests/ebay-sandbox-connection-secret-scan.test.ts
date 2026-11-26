import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { ChannelsApiEnv } from "../../../api";
import { createEbayConnectionRoutes } from "../api/route";
import { createEbayConnectionRuntime } from "../api/runtime";
import { createEbayOAuthProvider, revokeCurrentGrant } from "../api/provider";
import { config, context, owner } from "./db-support";

describe("ebay-sandbox-connection-secret-scan", () => {
  it("never exposes provider exception material in responses, logs or metadata", async () => {
    const marker = "synthetic-token-code-userId-username-marker";
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    try {
      const service = createEbayConnectionRuntime({
        configuration: config,
        keyring: null,
        db: {
          query: async () => {
            throw new Error(marker);
          },
          connect: async () => {
            throw new Error(marker);
          },
        },
        eventStore: {} as never,
      });
      const app = new Hono<ChannelsApiEnv>();
      app.use("*", async (c, next) => {
        c.set("actor", { accountId: owner, permissions: ["channels.manage"] });
        c.set("context", context());
        await next();
      });
      app.route("/", createEbayConnectionRoutes(service));
      const response = await app.request("/callback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ state: "a".repeat(43), code: marker }),
      });
      expect(await response.text()).not.toContain(marker);
      expect(response.status).toBe(409);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(JSON.stringify(logs.map((log) => log.mock.calls))).not.toContain(marker);
    } finally {
      logs.forEach((log) => log.mockRestore());
    }
  });
  it("closes captured provider shapes, rejects cap+1 bytes, and pins Sandbox-only transport", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const transport: typeof fetch = vi.fn(async (input, init) => {
      calls.push({ url: String(input), init });
      if (String(input).includes("/user/"))
        return Response.json({
          accountType: "INDIVIDUAL",
          registrationMarketplaceId: "EBAY_US",
          userId: "synthetic-subject",
          username: "synthetic-name",
        });
      return Response.json({
        access_token: "synthetic-access",
        refresh_token: "synthetic-refresh",
        expires_in: 7200,
        refresh_token_expires_in: 47304000,
        token_type: "User Access Token",
      });
    });
    const provider = createEbayOAuthProvider(config, transport),
      signal = AbortSignal.timeout(1000);
    const token = await provider.exchange("synthetic-code", signal);
    expect(await provider.identity(token.accessToken, signal)).toBe("synthetic-subject");
    expect(calls.map(({ url }) => new URL(url).hostname)).toEqual(["api.sandbox.ebay.com", "apiz.sandbox.ebay.com"]);
    expect(calls[0].init?.redirect).toBe("error");
    expect(new URLSearchParams(String(calls[0].init?.body)).get("redirect_uri")).toBe(config.ruName);
    const oversized = createEbayOAuthProvider(
      config,
      vi.fn(async () => new Response("x".repeat(65537))),
    );
    await expect(oversized.exchange("synthetic-code", signal)).rejects.toMatchObject({
      code: "invalid-provider-response",
    });
  });
  it("bounds revocation retries under one signal and cannot manufacture affirmative evidence", async () => {
    const provider = { exchange: vi.fn(), refresh: vi.fn(), identity: vi.fn(), revoke: vi.fn(async () => 503) };
    expect(await revokeCurrentGrant(provider, "synthetic-refresh")).toBe("unconfirmed");
    expect(provider.revoke).toHaveBeenCalledTimes(3);
    const signals = provider.revoke.mock.calls.map((call) => Reflect.get(call, "1"));
    expect(new Set(signals).size).toBe(1);
    expect(await revokeCurrentGrant(null, null)).toBe("unconfirmed");
  });
});
