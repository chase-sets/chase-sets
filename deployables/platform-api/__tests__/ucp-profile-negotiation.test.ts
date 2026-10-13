import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedActor } from "@chase-sets/auth-context";
import { buildAccountCapabilityRegistry } from "@chase-sets/platform-runtime/api";
import {
  createUcpEnvelope,
  createUcpProfileResolver,
  UCP_VERSION,
  type UcpIdempotencyStore,
} from "@chase-sets/platform-runtime/ucp";
import { buildPlatformApiApp } from "../src/app";

const profileUrl = "https://platform.example/profiles/shopping-agent.json";
const profile = {
  ucp: {
    version: UCP_VERSION,
    services: {},
    payment_handlers: {},
    capabilities: {
      "dev.ucp.shopping.checkout": [{ version: UCP_VERSION, spec: profileUrl, schema: profileUrl }],
      "dev.ucp.shopping.order": [{ version: UCP_VERSION, spec: profileUrl, schema: profileUrl }],
      "dev.ucp.shopping.catalog.search": [{ version: UCP_VERSION, spec: profileUrl, schema: profileUrl }],
    },
  },
};
const buyer: ResolvedActor = {
  sessionId: "ucp:grant_1",
  tenantId: "tenant_1",
  userId: "user_1",
  accountId: "buyer_1",
  membershipId: "member_1",
  roleKey: "buyer",
  permissions: ["orders.manage"],
  agentGrant: {
    grantId: "grant_1",
    platformProfileUrl: profileUrl,
    scopes: ["checkout:write"],
    rolePermissions: ["orders.manage"],
  },
};

afterEach(() => vi.useRealTimers());

function fixture(response: () => Response | Promise<Response> = () => Response.json(profile)) {
  const handler = vi.fn((_input: unknown) => createUcpEnvelope("ok", { checkout: { id: "checkout_1" }, products: [] }));
  const reserve = vi.fn<UcpIdempotencyStore["reserve"]>((input) => ({
    outcome: "reserved",
    record: { ...input, status: "pending", response: null },
  }));
  const store: UcpIdempotencyStore = {
    reserve,
    get: vi.fn(() => null),
    complete: vi.fn(),
    abandon: vi.fn(),
    put: vi.fn(),
  };
  const fetch = vi.fn(async () => response());
  const profileResolver = createUcpProfileResolver({
    db: {
      async query() {
        return { rows: [], rowCount: 0 };
      },
    },
    fetch,
    lookup: async () => [{ address: "8.8.8.8", family: 4 }],
  });
  const runtime: Parameters<typeof buildPlatformApiApp>[0] = {
    accountCapabilityRegistry: buildAccountCapabilityRegistry([]),
    mountedContexts: [],
    mountedModules: [],
    services: { auth: {}, identity: {} },
    projectionGroups: [],
    subscriptionRunners: [],
  };
  const app = buildPlatformApiApp(runtime, {
    resolveActor: async (request) => (request.headers.get("Authorization") === "Bearer valid" ? buyer : null),
    ucp: {
      profileResolver,
      idempotencyStore: store,
      restHandlers: { create_checkout: handler, get_order: handler, search_catalog: handler },
      mcpToolHandlers: {
        create_checkout: (input) =>
          input.actor
            ? handler(input)
            : createUcpEnvelope("error", {}, [
                {
                  severity: "error",
                  code: "authentication_required",
                  message: "Authenticate first.",
                },
              ]),
        complete_checkout: handler,
        search_catalog: handler,
      },
    },
  });
  return { app, handler, reserve, fetch };
}

function signedHeaders(body: string, headers: Record<string, string> = {}) {
  return {
    "Content-Type": "application/json",
    "UCP-Agent": `profile="${profileUrl}"`,
    "Idempotency-Key": "retry_1",
    "Signature-Input": 'sig1=("@method" "@path" "content-digest");created=1778940000',
    Signature: "sig1=:placeholder:",
    "Content-Digest": `sha-256=:${createHash("sha256").update(body).digest("base64")}:`,
    ...headers,
  };
}

describe("platform API UCP profile negotiation", () => {
  it("serves the pinned create_checkout argument-meta example without leaking meta to the handler", async () => {
    const { app, handler } = fixture();
    const args = {
      meta: { "ucp-agent": { profile: profileUrl }, "idempotency-key": "retry_1" },
      checkout: { line_items: [] },
    };
    const response = await app.request("/ucp/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer valid" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "create_checkout", arguments: args },
      }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).result.structuredContent.ucp.status).toBe("ok");
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ arguments: { checkout: { line_items: [] } } }));
  });

  it.each([
    [
      "bad version",
      () => Response.json({ ...profile, ucp: { ...profile.ucp, version: "1900-01-01" } }),
      "version_unsupported",
    ],
    ["invalid JSON", () => new Response("{"), "profile_malformed"],
    ["schema invalid", () => Response.json({ ucp: { version: UCP_VERSION } }), "profile_malformed"],
    ["404", () => new Response("", { status: 404 }), "profile_unreachable"],
    ["503", () => new Response("", { status: 503 }), "profile_unreachable"],
    ["redirect", () => new Response("", { status: 302, headers: { Location: profileUrl } }), "profile_unreachable"],
  ] as const)("ucp negotiates platform profiles before effects: %s", async (_name, response, code) => {
    const { app, handler, reserve } = fixture(response);
    for (const transport of ["rest", "mcp"]) {
      const bytes: string[] = [];
      for (const token of ["valid", "invalid", ""]) {
        const body =
          transport === "rest"
            ? "{}"
            : JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "tools/call",
                params: {
                  name: "complete_checkout",
                  arguments: { meta: { "ucp-agent": { profile: profileUrl } }, id: "checkout_1" },
                },
              });
        const result = await app.request(transport === "rest" ? "/ucp/v1/checkout-sessions" : "/ucp/mcp", {
          method: "POST",
          body,
          headers: signedHeaders(body, token ? { Authorization: `Bearer ${token}` } : {}),
        });
        const text = await result.text();
        const resultBody = JSON.parse(text);
        expect(transport === "rest" ? resultBody.messages[0].code : resultBody.error.data.code).toBe(code);
        if (transport === "mcp") expect(resultBody.error.code).toBe(-32001);
        else expect(result.status).toBe(code === "profile_unreachable" ? 424 : 422);
        bytes.push(text);
      }
      expect(new Set(bytes).size).toBe(1);
    }
    expect(handler).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });

  it("ucp negotiates platform profiles before effects: timeout is token-independent on both transports", async () => {
    vi.useFakeTimers();
    const { app, handler, reserve } = fixture(() => new Promise(() => {}));
    for (const transport of ["rest", "mcp"]) {
      const bytes: string[] = [];
      for (const token of ["valid", "invalid", ""]) {
        const body =
          transport === "rest"
            ? "{}"
            : JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "tools/call",
                params: { name: "complete_checkout", arguments: {} },
              });
        const pending = app.request(transport === "rest" ? "/ucp/v1/checkout-sessions" : "/ucp/mcp", {
          method: "POST",
          body,
          headers: signedHeaders(body, token ? { Authorization: `Bearer ${token}` } : {}),
        });
        await vi.advanceTimersByTimeAsync(5000);
        const response = await pending;
        const text = await response.text();
        const result = JSON.parse(text);
        expect(transport === "rest" ? result.messages[0].code : result.error.data.code).toBe("profile_unreachable");
        bytes.push(text);
      }
      expect(new Set(bytes).size).toBe(1);
    }
    expect(handler).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });

  it("runs MCP protocol resolution before profile negotiation and ignores params._meta as UCP arguments", async () => {
    const { app, fetch, handler } = fixture();
    const badProtocol = await app.request("/ucp/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "create_checkout",
          _meta: { "io.modelcontextprotocol/protocolVersion": "1900-01-01" },
          arguments: { meta: { "ucp-agent": "x" } },
        },
      }),
    });
    expect((await badProtocol.json()).error.code).toBe(-32022);
    expect(fetch).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    const legacy = await app.request("/ucp/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer valid" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "create_checkout", _meta: { "ucp-agent": "x" }, arguments: {} },
      }),
    });
    expect((await legacy.json()).result.structuredContent.ucp.status).toBe("ok");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    "x",
    null,
    [],
    {},
    { profile: "" },
    { profile: 7 },
    { profile: "http://platform.example/profile" },
    { profile: "https://other.example/profile" },
  ])("rejects malformed or disagreeing argument profiles before effects: %j", async (agent) => {
    const { app, handler, reserve } = fixture();
    const bytes: string[] = [];
    for (const token of ["valid", "invalid", ""]) {
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "complete_checkout", arguments: { meta: { "ucp-agent": agent } } },
      });
      const result = await app.request("/ucp/mcp", {
        method: "POST",
        body,
        headers: signedHeaders(body, token ? { Authorization: `Bearer ${token}` } : {}),
      });
      const text = await result.text();
      expect(JSON.parse(text).error.data.code).toBe("invalid_profile_url");
      bytes.push(text);
    }
    expect(new Set(bytes).size).toBe(1);
    expect(handler).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });

  it("missing-profile REST checkout and order fail closed, while catalog is public on both transports", async () => {
    const { app, fetch, reserve } = fixture();
    for (const [path, method] of [
      ["/ucp/v1/checkout-sessions", "POST"],
      ["/ucp/v1/orders/order_1", "GET"],
    ]) {
      const response = await app.request(path, { method });
      expect(response.status).toBe(400);
      expect((await response.json()).messages[0].code).toBe("invalid_profile_url");
    }
    const rest = await app.request("/ucp/v1/catalog/search", { method: "POST" });
    expect((await rest.json()).ucp.status).toBe("ok");
    const mcp = await app.request("/ucp/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "search_catalog", arguments: {} },
      }),
    });
    expect((await mcp.json()).result.structuredContent.ucp.status).toBe("ok");
    expect(fetch).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });

  it.each([
    "",
    "x",
    'profile=""',
    'profile="http://platform.example/profile"',
    'profile="https://platform.example/profile" profile="https://other.example/profile"',
  ])("ucp negotiates platform profiles before effects: malformed header %j", async (header) => {
    const { app, handler, reserve, fetch } = fixture();
    for (const transport of ["rest", "mcp"]) {
      const bytes: string[] = [];
      for (const token of ["valid", "invalid", ""]) {
        const body =
          transport === "rest"
            ? "{}"
            : JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "tools/call",
                params: { name: "complete_checkout", arguments: {} },
              });
        const response = await app.request(transport === "rest" ? "/ucp/v1/checkout-sessions" : "/ucp/mcp", {
          method: "POST",
          body,
          headers: signedHeaders(body, { "UCP-Agent": header, ...(token ? { Authorization: `Bearer ${token}` } : {}) }),
        });
        const text = await response.text();
        const result = JSON.parse(text);
        expect(transport === "rest" ? result.messages[0].code : result.error.data.code).toBe("invalid_profile_url");
        bytes.push(text);
      }
      expect(new Set(bytes).size).toBe(1);
    }
    expect(handler).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("missing-profile MCP host extension requires OAuth and never fetches a profile", async () => {
    const { app, fetch } = fixture();
    for (const token of ["", "valid"]) {
      const response = await app.request("/ucp/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "create_checkout", arguments: {} },
        }),
      });
      const result = (await response.json()).result;
      expect(result.structuredContent.ucp.status).toBe(token ? "ok" : "error");
      if (!token) expect(result._meta["mcp/www_authenticate"]).toBeDefined();
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects disagreeing argument and header retry keys without reservation", async () => {
    const { app, handler, reserve } = fixture();
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "complete_checkout",
        arguments: { meta: { "ucp-agent": { profile: profileUrl }, "idempotency-key": "different" } },
      },
    });
    const response = await app.request("/ucp/mcp", { method: "POST", body, headers: signedHeaders(body) });
    expect((await response.json()).error.data.code).toBe("idempotency_key_mismatch");
    expect(handler).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });
});
