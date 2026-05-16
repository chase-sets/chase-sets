import { createHash, createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { UCP_MCP_TOOLS, UCP_VERSION } from "@chase-sets/ucp";
import {
  createPostgresUcpIdempotencyStore,
  createUcpMcpRoutes,
  createUcpProfileKeyResolver,
  createUcpProfileRoutes,
  createUcpRestRoutes,
} from "./ucp";

function signedHeaders(body: string, extra: Readonly<Record<string, string>> = {}) {
  return {
    "Content-Type": "application/json",
    "UCP-Agent": 'profile="https://agent.example/.well-known/ucp"',
    "Signature-Input": 'sig1=("@method" "@path" "content-digest");created=1778940000',
    Signature: "sig1=:placeholder:",
    "Content-Digest": `sha-256=:${createHash("sha256").update(body).digest("base64")}:`,
    ...extra,
  };
}

function signedHeadersWithKey(
  method: string,
  path: string,
  body: string,
  privateKey: KeyObject,
  extra: Readonly<Record<string, string>> = {},
) {
  const contentDigest = `sha-256=:${createHash("sha256").update(body).digest("base64")}:`;
  const signatureParams = '("@method" "@path" "content-digest");keyid="platform-2026"';
  const signatureBase = [
    `"@method": ${method.toUpperCase()}`,
    `"@path": ${path}`,
    `"content-digest": ${contentDigest}`,
    `"@signature-params": ${signatureParams}`,
  ].join("\n");
  const signature = createSign("sha256").update(signatureBase).end().sign(privateKey).toString("base64");

  return {
    "Content-Type": "application/json",
    "UCP-Agent": 'profile="https://agent.example/.well-known/ucp"',
    "Signature-Input": `sig1=${signatureParams}`,
    Signature: `sig1=:${signature}:`,
    "Content-Digest": contentDigest,
    ...extra,
  };
}

describe("UCP profile routes", () => {
  it("serves the business profile from the request origin", async () => {
    const app = new Hono().route("/.well-known", createUcpProfileRoutes());

    const response = await app.request("https://marketplace.example/.well-known/ucp");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ucp: {
        version: UCP_VERSION,
        services: {
          "dev.ucp.shopping": [
            { transport: "rest", endpoint: "https://marketplace.example/ucp/v1" },
            { transport: "mcp", endpoint: "https://marketplace.example/ucp/mcp" },
          ],
        },
      },
    });
  });

  it("uses HTTPS for public hosts reached through internal HTTP", async () => {
    const app = new Hono().route("/.well-known", createUcpProfileRoutes());

    const response = await app.request("http://marketplace.staging.chasesets.com/.well-known/ucp");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ucp: {
        services: {
          "dev.ucp.shopping": [
            { transport: "rest", endpoint: "https://marketplace.staging.chasesets.com/ucp/v1" },
            { transport: "mcp", endpoint: "https://marketplace.staging.chasesets.com/ucp/mcp" },
          ],
        },
      },
    });
  });

  it("keeps http endpoints for local development hosts", async () => {
    const app = new Hono().route("/.well-known", createUcpProfileRoutes());

    const response = await app.request("http://localhost:7712/.well-known/ucp");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ucp: {
        services: {
          "dev.ucp.shopping": [
            { transport: "rest", endpoint: "http://localhost:7712/ucp/v1" },
            { transport: "mcp", endpoint: "http://localhost:7712/ucp/mcp" },
          ],
        },
      },
    });
  });
});

describe("UCP REST routes", () => {
  it("rejects checkout writes that are not signed", async () => {
    const app = new Hono().route("/ucp/v1", createUcpRestRoutes());

    const response = await app.request("/ucp/v1/checkout-sessions", {
      method: "POST",
      body: "{}",
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ucp: { status: "error" },
      messages: [
        {
          code: "signed_request_required",
        },
      ],
    });
  });

  it("replays the stored response for duplicate REST writes with the same idempotency key and body", async () => {
    const handler = vi.fn(async () => ({
      ucp: { version: UCP_VERSION, status: "ok" as const },
      checkout: { id: `chk_${handler.mock.calls.length}` },
    }));
    const app = new Hono().route("/ucp/v1", createUcpRestRoutes({
      restHandlers: {
        create_checkout: handler,
      },
    }));
    const body = JSON.stringify({ source: { type: "cart" } });
    const headers = signedHeaders(body, { "Idempotency-Key": "idem_1" });

    const first = await app.request("/ucp/v1/checkout-sessions", {
      method: "POST",
      body,
      headers,
    });
    const second = await app.request("/ucp/v1/checkout-sessions", {
      method: "POST",
      body,
      headers,
    });

    expect(handler).toHaveBeenCalledTimes(1);
    await expect(first.json()).resolves.toMatchObject({ checkout: { id: "chk_1" } });
    await expect(second.json()).resolves.toMatchObject({ checkout: { id: "chk_1" } });
  });

  it("rejects REST idempotency-key reuse with different request bodies", async () => {
    const handler = vi.fn(async () => ({
      ucp: { version: UCP_VERSION, status: "ok" as const },
      checkout: { id: "chk_1" },
    }));
    const app = new Hono().route("/ucp/v1", createUcpRestRoutes({
      restHandlers: {
        create_checkout: handler,
      },
    }));
    const firstBody = JSON.stringify({ source: { type: "cart" } });
    const secondBody = JSON.stringify({ source: { type: "buy-now" } });

    await app.request("/ucp/v1/checkout-sessions", {
      method: "POST",
      body: firstBody,
      headers: signedHeaders(firstBody, { "Idempotency-Key": "idem_1" }),
    });
    const second = await app.request("/ucp/v1/checkout-sessions", {
      method: "POST",
      body: secondBody,
      headers: signedHeaders(secondBody, { "Idempotency-Key": "idem_1" }),
    });

    expect(second.status).toBe(409);
    expect(handler).toHaveBeenCalledTimes(1);
    await expect(second.json()).resolves.toMatchObject({
      messages: [{ code: "idempotency_key_conflict" }],
    });
  });

  it("emits observer events for completed writes, replays, and idempotency conflicts", async () => {
    const events: string[] = [];
    const handler = vi.fn(async () => ({
      ucp: { version: UCP_VERSION, status: "ok" as const },
      checkout: { id: "chk_1" },
    }));
    const app = new Hono().route("/ucp/v1", createUcpRestRoutes({
      restHandlers: {
        create_checkout: handler,
      },
      observer: {
        operationCompleted: (event) => events.push(`completed:${event.operation}:${event.status}`),
        idempotencyReplayed: (event) => events.push(`replayed:${event.operation}`),
        idempotencyConflict: (event) => events.push(`conflict:${event.operation}`),
      },
    }));
    const firstBody = JSON.stringify({ source: { type: "cart" } });
    const secondBody = JSON.stringify({ source: { type: "buy-now" } });

    await app.request("/ucp/v1/checkout-sessions", {
      method: "POST",
      body: firstBody,
      headers: signedHeaders(firstBody, { "Idempotency-Key": "idem_events" }),
    });
    await app.request("/ucp/v1/checkout-sessions", {
      method: "POST",
      body: firstBody,
      headers: signedHeaders(firstBody, { "Idempotency-Key": "idem_events" }),
    });
    await app.request("/ucp/v1/checkout-sessions", {
      method: "POST",
      body: secondBody,
      headers: signedHeaders(secondBody, { "Idempotency-Key": "idem_events" }),
    });

    expect(events).toEqual([
      "completed:create_checkout:ok",
      "replayed:create_checkout",
      "conflict:create_checkout",
    ]);
  });

  it("verifies HTTP Message Signatures when a UCP key resolver is configured", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const publicJwk = publicKey.export({ format: "jwk" });
    const handler = vi.fn(async () => ({
      ucp: { version: UCP_VERSION, status: "ok" as const },
      checkout: { id: "chk_signed" },
    }));
    const app = new Hono().route("/ucp/v1", createUcpRestRoutes({
      restHandlers: {
        create_checkout: handler,
      },
      signatureVerification: {
        keyResolver: vi.fn(async (profileUrl, keyId) =>
          profileUrl === "https://agent.example/.well-known/ucp" && keyId === "platform-2026"
            ? publicJwk
            : null,
        ),
      },
    }));
    const body = JSON.stringify({ source: { type: "cart" } });

    const response = await app.request("/ucp/v1/checkout-sessions", {
      method: "POST",
      body,
      headers: signedHeadersWithKey(
        "POST",
        "/ucp/v1/checkout-sessions",
        body,
        privateKey,
        { "Idempotency-Key": "idem_signed" },
      ),
    });

    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    await expect(response.json()).resolves.toMatchObject({
      checkout: { id: "chk_signed" },
    });
  });

  it("rejects checkout completion without an idempotency key before invoking handlers", async () => {
    const handler = vi.fn();
    const app = new Hono().route("/ucp/v1", createUcpRestRoutes({
      restHandlers: {
        complete_checkout: handler,
      },
    }));
    const body = "{}";

    const response = await app.request("/ucp/v1/checkout-sessions/chk_1/complete", {
      method: "POST",
      body,
      headers: signedHeaders(body),
    });

    expect(response.status).toBe(400);
    expect(handler).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      messages: [{ code: "idempotency_key_required" }],
    });
  });

  it("verifies Content-Digest before invoking signed checkout write handlers", async () => {
    const handler = vi.fn();
    const app = new Hono().route("/ucp/v1", createUcpRestRoutes({
      restHandlers: {
        create_checkout: handler,
      },
    }));

    const response = await app.request("/ucp/v1/checkout-sessions", {
      method: "POST",
      body: "{\"changed\":true}",
      headers: signedHeaders("{}", { "Idempotency-Key": "idem_1" }),
    });

    expect(handler).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      messages: [{ code: "signed_request_required" }],
    });
  });
});

describe("UCP profile key cache", () => {
  it("caches fetched agent signing keys in the platform store", async () => {
    const db = createFakeProfileDb();
    const fetch = vi.fn(async () =>
      new Response(JSON.stringify({
        signing_keys: [
          { kid: "platform-2026", kty: "RSA", n: "abc", e: "AQAB" },
        ],
      }), { status: 200 }),
    );
    const resolver = createUcpProfileKeyResolver({
      db,
      fetch,
      ttlMs: 60_000,
      now: () => new Date("2026-05-16T00:00:00.000Z"),
    });

    const first = await resolver("https://agent.example/.well-known/ucp", "platform-2026");
    const second = await resolver("https://agent.example/.well-known/ucp", "platform-2026");

    expect(first).toMatchObject({ kid: "platform-2026" });
    expect(second).toMatchObject({ kid: "platform-2026" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("UCP Postgres idempotency store", () => {
  it("sets retention expiry, ignores expired replay records, and prunes old records", async () => {
    const db = createFakeIdempotencyDb();
    const store = createPostgresUcpIdempotencyStore(db, {
      retentionMs: 60_000,
      now: () => new Date("2026-05-16T12:02:00.000Z"),
    });
    await store.put({
      key: "idem_1",
      requestHash: "hash_1",
      response: { ucp: { version: UCP_VERSION, status: "ok" } },
      createdAt: "2026-05-16T12:00:00.000Z",
    });

    await expect(store.get("idem_1")).resolves.toBeNull();
    await expect(store.pruneExpired?.()).resolves.toBe(1);
  });
});

describe("UCP MCP routes", () => {
  it("lists UCP tool names instead of Chase Sets-native MCP descriptors", async () => {
    const app = new Hono().route("/ucp/mcp", createUcpMcpRoutes());

    const response = await app.request("/ucp/mcp", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: "1", method: "tools/list" }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result.tools.map((tool: { name: string }) => tool.name)).toEqual(
      UCP_MCP_TOOLS.map((tool) => tool.name),
    );
  });

  it("requires idempotency for complete_checkout tool calls", async () => {
    const app = new Hono().route("/ucp/mcp", createUcpMcpRoutes());

    const response = await app.request("/ucp/mcp", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "1",
        method: "tools/call",
        params: {
          name: "complete_checkout",
          arguments: { id: "chk_1" },
        },
      }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        message: "Idempotency-Key is required for complete_checkout.",
      },
    });
  });

  it("passes MCP tool arguments to UCP handlers", async () => {
    const handler = vi.fn(async ({ arguments: args }) => ({
      ucp: { version: UCP_VERSION, status: "ok" as const },
      observed: args,
    }));
    const app = new Hono().route("/ucp/mcp", createUcpMcpRoutes({
      mcpToolHandlers: {
        search_catalog: handler,
      },
    }));

    const response = await app.request("/ucp/mcp", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "1",
        method: "tools/call",
        params: {
          name: "search_catalog",
          arguments: { query: "charizard" },
        },
      }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      arguments: { query: "charizard" },
    }));
    await expect(response.json()).resolves.toMatchObject({
      result: {
        content: [{ json: { observed: { query: "charizard" } } }],
      },
    });
  });

  it("replays idempotent MCP tool calls and rejects changed bodies for the same key", async () => {
    const handler = vi.fn(async () => ({
      ucp: { version: UCP_VERSION, status: "ok" as const },
      checkout: { id: `chk_${handler.mock.calls.length}` },
    }));
    const app = new Hono().route("/ucp/mcp", createUcpMcpRoutes({
      mcpToolHandlers: {
        complete_checkout: handler,
      },
    }));
    const firstBody = JSON.stringify({
      jsonrpc: "2.0",
      id: "1",
      method: "tools/call",
      params: {
        name: "complete_checkout",
        arguments: { id: "chk_1" },
      },
    });
    const secondBody = JSON.stringify({
      jsonrpc: "2.0",
      id: "2",
      method: "tools/call",
      params: {
        name: "complete_checkout",
        arguments: { id: "chk_2" },
      },
    });

    const first = await app.request("/ucp/mcp", {
      method: "POST",
      body: firstBody,
      headers: signedHeaders(firstBody, { "Idempotency-Key": "idem_2" }),
    });
    const replay = await app.request("/ucp/mcp", {
      method: "POST",
      body: firstBody,
      headers: signedHeaders(firstBody, { "Idempotency-Key": "idem_2" }),
    });
    const conflict = await app.request("/ucp/mcp", {
      method: "POST",
      body: secondBody,
      headers: signedHeaders(secondBody, { "Idempotency-Key": "idem_2" }),
    });

    expect(handler).toHaveBeenCalledTimes(1);
    await expect(first.json()).resolves.toMatchObject({
      result: { content: [{ json: { checkout: { id: "chk_1" } } }] },
    });
    await expect(replay.json()).resolves.toMatchObject({
      result: { content: [{ json: { checkout: { id: "chk_1" } } }] },
    });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      error: {
        message: "Idempotency-Key was already used with different request parameters.",
      },
    });
  });
});

function createFakeProfileDb() {
  const profiles = new Map<string, {
    profile: unknown;
    expires_at: string;
  }>();

  return {
    async query<Row = Record<string, unknown>>(
      text: string,
      values: readonly unknown[] = [],
    ) {
      if (text.includes("SELECT profile, expires_at")) {
        const row = profiles.get(String(values[0]));
        return {
          rows: row ? [row as Row] : [],
          rowCount: row ? 1 : 0,
        };
      }

      if (text.includes("INSERT INTO platform_ucp_agent_profiles")) {
        profiles.set(String(values[0]), {
          profile: JSON.parse(String(values[1] ?? "{}")),
          expires_at: String(values[3] ?? new Date().toISOString()),
        });
        return { rows: [], rowCount: 1 };
      }

      throw new Error(`Unexpected query: ${text}`);
    },
  };
}

function createFakeIdempotencyDb() {
  const records = new Map<string, {
    key: string;
    request_hash: string;
    response: unknown;
    created_at: string;
    expires_at: string | null;
  }>();

  return {
    async query<Row = Record<string, unknown>>(
      text: string,
      values: readonly unknown[] = [],
    ) {
      if (text.includes("INSERT INTO platform_ucp_idempotency_records")) {
        const row = {
          key: String(values[0]),
          request_hash: String(values[1]),
          response: JSON.parse(String(values[2] ?? "{}")),
          created_at: String(values[3]),
          expires_at: values[4] ? String(values[4]) : null,
        };
        records.set(row.key, row);
        return { rows: [], rowCount: 1 };
      }

      if (text.includes("SELECT key, request_hash")) {
        const row = records.get(String(values[0]));
        const live = row && (!row.expires_at || new Date(row.expires_at).getTime() > Date.now());
        return {
          rows: live ? [row as Row] : [],
          rowCount: live ? 1 : 0,
        };
      }

      if (text.includes("DELETE FROM platform_ucp_idempotency_records")) {
        const now = new Date(String(values[0])).getTime();
        let rowCount = 0;
        for (const [key, row] of records) {
          if (row.expires_at && new Date(row.expires_at).getTime() <= now) {
            records.delete(key);
            rowCount += 1;
          }
        }
        return { rows: [], rowCount };
      }

      throw new Error(`Unexpected query: ${text}`);
    },
  };
}
