import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import {
  UCP_MCP_CART_REVIEW_RESOURCE_URI,
  UCP_MCP_CHECKOUT_HANDOFF_RESOURCE_URI,
  UCP_MCP_PRODUCT_CARDS_RESOURCE_URI,
  UCP_MCP_TOOLS,
  UCP_VERSION,
} from "./ucp";
import {
  MCP_LEGACY_PROTOCOL_VERSIONS,
  MCP_META_PROTOCOL_VERSION_KEY,
  MCP_META_CLIENT_CAPABILITIES_KEY,
  MCP_METHOD_HEADER,
  MCP_NAME_HEADER,
  MCP_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSION_2025_11_25,
  MCP_PROTOCOL_VERSION_HEADER,
} from "./mcp-protocol";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { ResolvedActor } from "./auth";
import { resolveAgentOAuthScopedPermissions, agentOAuthScopesForPermissions } from "@chase-sets/auth-context";
import {
  createPostgresUcpIdempotencyStore,
  createUcpMcpRoutes as buildUcpMcpRoutes,
  createUcpProfileKeyResolver,
  createUcpProfileRoutes,
  createUcpRestRoutes as buildUcpRestRoutes,
  createUcpProfileResolver,
  createUcpEnvelope,
  publicUcpBusinessSigningKeys,
  type CreateUcpRoutesOptions,
  type UcpProfileResolver,
} from "./ucp";

const testPlatformProfile = {
  ucp: {
    version: UCP_VERSION,
    services: {},
    payment_handlers: {},
    capabilities: Object.fromEntries(
      UCP_MCP_TOOLS.map((tool) => [
        tool.capability,
        [{ version: UCP_VERSION, spec: "https://ucp.dev/spec", schema: "https://ucp.dev/schema" }],
      ]),
    ),
  },
};
const resolveTestProfile: UcpProfileResolver = async () => ({ ok: true, profile: testPlatformProfile });
function createUcpRestRoutes(options: CreateUcpRoutesOptions = {}) {
  return buildUcpRestRoutes({ profileResolver: resolveTestProfile, ...options });
}
function createUcpMcpRoutes(options: CreateUcpRoutesOptions = {}) {
  return buildUcpMcpRoutes({ profileResolver: resolveTestProfile, ...options });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

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
  options: Readonly<{
    createdSeconds?: number;
    omitCoveredComponents?: readonly string[];
  }> = {},
) {
  const contentDigest = `sha-256=:${createHash("sha256").update(body).digest("base64")}:`;
  const url = new URL(path, "https://marketplace.example");
  const coveredComponents = ["@method", "@path", ...(url.search ? ["@query"] : []), "content-digest"];
  if (Object.keys(extra).some((key) => key.toLowerCase() === "idempotency-key")) {
    coveredComponents.push("idempotency-key");
  }
  const omitted = new Set(options.omitCoveredComponents ?? []);
  const components = coveredComponents.filter((component) => !omitted.has(component));
  const createdSeconds = options.createdSeconds ?? Math.floor(Date.now() / 1000);
  const componentParams = components.map((component) => `"${component}"`).join(" ");
  const signatureParams = `(${componentParams});created=${createdSeconds};keyid="platform-2026"`;
  const signatureBase = [
    ...components.map((component) => {
      switch (component) {
        case "@method":
          return `"@method": ${method.toUpperCase()}`;
        case "@path":
          return `"@path": ${url.pathname}`;
        case "@query":
          return `"@query": ${url.search}`;
        case "content-digest":
          return `"content-digest": ${contentDigest}`;
        default:
          return `"${component}": ${extra[Object.keys(extra).find((key) => key.toLowerCase() === component) ?? component]}`;
      }
    }),
    `"@signature-params": ${signatureParams}`,
  ].join("\n");
  const algorithm = privateKey.asymmetricKeyType === "ed25519" ? null : "sha256";
  const signature = sign(algorithm, Buffer.from(signatureBase), privateKey).toString("base64");

  return {
    "Content-Type": "application/json",
    "UCP-Agent": 'profile="https://agent.example/.well-known/ucp"',
    "Signature-Input": `sig1=${signatureParams}`,
    Signature: `sig1=:${signature}:`,
    "Content-Digest": contentDigest,
    ...extra,
  };
}

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

const JWK_REPRESENTATIONS = ["own", "inherited", "non-enumerable"] as const;
type JwkRepresentation = (typeof JWK_REPRESENTATIONS)[number];

// Node reads JWK members with ordinary property access, so inherited and non-enumerable
// members are valid key material that an own-enumerable copy would silently drop.
function representJwk(jwk: JsonWebKey, representation: JwkRepresentation): JsonWebKey {
  if (representation === "own") {
    return Object.freeze({ ...jwk });
  }
  if (representation === "inherited") {
    return Object.freeze(Object.create(Object.freeze({ ...jwk })));
  }
  const hidden = {};
  for (const [member, value] of Object.entries(jwk)) {
    Object.defineProperty(hidden, member, { value, enumerable: false });
  }
  return Object.freeze(hidden);
}

function jwkShape(jwk: object) {
  return [Object.getOwnPropertyDescriptors(jwk), Object.getOwnPropertyDescriptors(Object.getPrototypeOf(jwk))];
}

function thrownBy(action: () => unknown): Error {
  try {
    action();
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected the action to throw.");
}

function errorFacts(error: Error) {
  return { name: error.name, message: error.message, code: Reflect.get(error, "code") };
}

describe("UCP profile routes", () => {
  it("buyer scopes use UCP capability tokens", () => {
    for (const tool of UCP_MCP_TOOLS.filter((tool) => tool.capability === "dev.ucp.shopping.checkout")) {
      expect(tool.securitySchemes, tool.name).toEqual([
        { type: "oauth2", scopes: ["dev.ucp.shopping.checkout:manage"] },
      ]);
    }
    expect(UCP_MCP_TOOLS.find((tool) => tool.name === "get_order")?.securitySchemes).toEqual([
      { type: "oauth2", scopes: ["dev.ucp.shopping.order:read"] },
    ]);
    expect(
      resolveAgentOAuthScopedPermissions(["dev.ucp.shopping.checkout:manage"], ["orders.view", "orders.manage"]),
    ).toEqual(["orders.view", "orders.manage"]);
    expect(
      resolveAgentOAuthScopedPermissions(["dev.ucp.shopping.order:read"], ["orders.view", "orders.manage"]),
    ).toEqual(["orders.view"]);
    expect(agentOAuthScopesForPermissions(["orders.view"])).toEqual([
      "dev.ucp.shopping.checkout:manage",
      "dev.ucp.shopping.order:read",
    ]);
  });

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

  it("publishes business signing keys", async () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const businessSigningKeys = {
      current: {
        kid: "merchant-2026",
        alg: "ES256" as const,
        privateJwk: privateKey.export({ format: "jwk" }),
      },
      previousPublicJwks: [{ kty: "EC", crv: "P-256", kid: "merchant-2025", x: "x", y: "y" }],
    };
    const app = new Hono().route(
      "/.well-known",
      createUcpProfileRoutes({
        businessSigningKeys,
      }),
    );

    const response = await app.request("https://marketplace.example/.well-known/ucp");
    const profile = await response.json();
    const publishedKeys = [
      {
        kty: "EC",
        crv: "P-256",
        kid: "merchant-2026",
        alg: "ES256",
        use: "sig",
        x: expect.any(String),
        y: expect.any(String),
      },
      { kid: "merchant-2025" },
    ];
    expect(profile).toMatchObject({
      signing_keys: publishedKeys,
      ucp: { signing_keys: publishedKeys },
    });
    expect(profile.signing_keys[0]).not.toHaveProperty("d");
    expect(profile.ucp.signing_keys[0]).not.toHaveProperty("d");
  });

  const businessSigningCurves = [
    { alg: "ES256", namedCurve: "P-256" },
    { alg: "ES384", namedCurve: "P-384" },
    { alg: "ES512", namedCurve: "P-521" },
  ] as const;

  it.each(
    businessSigningCurves.flatMap((curve) =>
      JWK_REPRESENTATIONS.map((representation) => ({ ...curve, representation })),
    ),
  )(
    "publishes the $alg business key from $representation private JWK members",
    async ({ alg, namedCurve, representation }) => {
      const { privateKey } = generateKeyPairSync("ec", { namedCurve });
      const privateJwk = representJwk(privateKey.export({ format: "jwk" }), representation);
      const shapeBefore = jwkShape(privateJwk);
      const app = new Hono().route(
        "/.well-known",
        createUcpProfileRoutes({ businessSigningKeys: { current: { kid: "merchant-2026", alg, privateJwk } } }),
      );

      const response = await app.request("https://marketplace.example/.well-known/ucp");

      expect(response.status).toBe(200);
      const profile = await response.json();
      const publishedKey = {
        ...createPublicKey(privateKey).export({ format: "jwk" }),
        kid: "merchant-2026",
        alg,
        use: "sig",
      };
      expect(profile.signing_keys).toEqual([publishedKey]);
      expect(profile.ucp.signing_keys).toEqual([publishedKey]);
      expect(jwkShape(privateJwk)).toEqual(shapeBefore);
    },
  );

  it.each(JWK_REPRESENTATIONS)(
    "rejects a public-only business key from %s JWK members with the Node key error",
    (representation) => {
      const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
      const publicJwk = publicKey.export({ format: "jwk" });
      const expected = thrownBy(() => createPrivateKey({ key: publicJwk, format: "jwk" }));
      const privateJwk = representJwk(publicJwk, representation);
      const shapeBefore = jwkShape(privateJwk);

      const actual = thrownBy(() =>
        publicUcpBusinessSigningKeys({ current: { kid: "merchant-2026", alg: "ES256", privateJwk } }),
      );

      expect(errorFacts(actual)).toEqual(errorFacts(expected));
      expect(jwkShape(privateJwk)).toEqual(shapeBefore);
    },
  );
});

describe("UCP REST routes", () => {
  it("requires a durable idempotency store outside the test runtime", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VITEST", "false");

    expect(() => createUcpRestRoutes()).toThrow(
      "REST UCP routes require a durable idempotencyStore. Bootstrap platformUcpRuntimeSchemaSql",
    );
    expect(() => createUcpMcpRoutes()).toThrow(
      "MCP UCP routes require a durable idempotencyStore. Bootstrap platformUcpRuntimeSchemaSql",
    );
  });

  it("rejects profile-less checkout writes and signals the negotiation failure", async () => {
    const negotiationRejected = vi.fn();
    const app = new Hono().route("/ucp/v1", createUcpRestRoutes({ observer: { negotiationRejected } }));

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
          code: "invalid_profile_url",
        },
      ],
    });
    expect(negotiationRejected).toHaveBeenCalledExactlyOnceWith({
      transport: "rest",
      operation: "create_checkout",
      code: "invalid_profile_url",
      profileHost: null,
    });
  });

  it("rejects profile-bearing checkout writes that are not signed", async () => {
    const signedWriteRejected = vi.fn();
    const negotiationRejected = vi.fn();
    const app = new Hono().route(
      "/ucp/v1",
      createUcpRestRoutes({ observer: { signedWriteRejected, negotiationRejected } }),
    );
    const response = await app.request("/ucp/v1/checkout-sessions", {
      method: "POST",
      body: "{}",
      headers: { "Content-Type": "application/json", "UCP-Agent": 'profile="https://agent.example/.well-known/ucp"' },
    });
    expect(response.status).toBe(400);
    expect((await response.json()).messages[0].code).toBe("signed_request_required");
    expect(signedWriteRejected).toHaveBeenCalledTimes(1);
    expect(negotiationRejected).not.toHaveBeenCalled();
  });

  it("replays the stored response for duplicate REST writes with the same idempotency key and body", async () => {
    const handler = vi.fn(async () => ({
      ucp: { version: UCP_VERSION, status: "ok" as const },
      checkout: { id: `chk_${handler.mock.calls.length}` },
    }));
    const app = new Hono().route(
      "/ucp/v1",
      createUcpRestRoutes({
        restHandlers: {
          create_checkout: handler,
        },
      }),
    );
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

  it("returns retry-later for duplicate REST writes while the first request is still pending", async () => {
    const started = createDeferred();
    const release = createDeferred();
    const handler = vi.fn(async () => {
      started.resolve();
      await release.promise;
      return {
        ucp: { version: UCP_VERSION, status: "ok" as const },
        checkout: { id: "chk_1" },
      };
    });
    const app = new Hono().route(
      "/ucp/v1",
      createUcpRestRoutes({
        restHandlers: {
          create_checkout: handler,
        },
      }),
    );
    const body = JSON.stringify({ source: { type: "cart" } });
    const headers = signedHeaders(body, { "Idempotency-Key": "idem_pending" });

    const first = app.request("/ucp/v1/checkout-sessions", {
      method: "POST",
      body,
      headers,
    });
    await started.promise;
    const duplicate = await app.request("/ucp/v1/checkout-sessions", {
      method: "POST",
      body,
      headers,
    });
    release.resolve();
    const firstResponse = await Promise.resolve(first);

    expect(duplicate.status).toBe(409);
    await expect(duplicate.json()).resolves.toMatchObject({
      messages: [{ code: "idempotency_key_in_progress" }],
    });
    await expect(firstResponse.json()).resolves.toMatchObject({
      checkout: { id: "chk_1" },
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does not replay REST error envelopes for duplicate write attempts", async () => {
    const handler = vi
      .fn()
      .mockImplementationOnce(async () => ({
        ucp: { version: UCP_VERSION, status: "error" as const },
        messages: [{ severity: "error" as const, code: "temporary_failure", message: "Try again." }],
      }))
      .mockImplementationOnce(async () => ({
        ucp: { version: UCP_VERSION, status: "ok" as const },
        checkout: { id: "chk_retry" },
      }));
    const app = new Hono().route(
      "/ucp/v1",
      createUcpRestRoutes({
        restHandlers: {
          create_checkout: handler,
        },
      }),
    );
    const body = JSON.stringify({ source: { type: "cart" } });
    const headers = signedHeaders(body, { "Idempotency-Key": "idem_error_retry" });

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

    expect(handler).toHaveBeenCalledTimes(2);
    await expect(first.json()).resolves.toMatchObject({
      ucp: { status: "error" },
      messages: [{ code: "temporary_failure" }],
    });
    await expect(second.json()).resolves.toMatchObject({
      ucp: { status: "ok" },
      checkout: { id: "chk_retry" },
    });
  });

  it("rejects REST idempotency-key reuse with different request bodies", async () => {
    const handler = vi.fn(async () => ({
      ucp: { version: UCP_VERSION, status: "ok" as const },
      checkout: { id: "chk_1" },
    }));
    const app = new Hono().route(
      "/ucp/v1",
      createUcpRestRoutes({
        restHandlers: {
          create_checkout: handler,
        },
      }),
    );
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
    const app = new Hono().route(
      "/ucp/v1",
      createUcpRestRoutes({
        restHandlers: {
          create_checkout: handler,
        },
        observer: {
          operationCompleted: (event) => events.push(`completed:${event.operation}:${event.status}`),
          idempotencyReplayed: (event) => events.push(`replayed:${event.operation}`),
          idempotencyConflict: (event) => events.push(`conflict:${event.operation}`),
        },
      }),
    );
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

    expect(events).toEqual(["completed:create_checkout:ok", "replayed:create_checkout", "conflict:create_checkout"]);
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
    const app = new Hono().route(
      "/ucp/v1",
      createUcpRestRoutes({
        restHandlers: {
          create_checkout: handler,
        },
        signatureVerification: {
          keyResolver: vi.fn(async (profileUrl, keyId) =>
            profileUrl === "https://agent.example/.well-known/ucp" && keyId === "platform-2026" ? publicJwk : null,
          ),
        },
      }),
    );
    const body = JSON.stringify({ source: { type: "cart" } });

    const response = await app.request("/ucp/v1/checkout-sessions", {
      method: "POST",
      body,
      headers: signedHeadersWithKey("POST", "/ucp/v1/checkout-sessions", body, privateKey, {
        "Idempotency-Key": "idem_signed",
      }),
    });

    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    await expect(response.json()).resolves.toMatchObject({
      checkout: { id: "chk_signed" },
    });
  });

  const signatureKeyFamilies = [
    { family: "RSA", generate: () => generateKeyPairSync("rsa", { modulusLength: 2048 }) },
    { family: "EC P-256", generate: () => generateKeyPairSync("ec", { namedCurve: "P-256" }) },
    { family: "Ed25519", generate: () => generateKeyPairSync("ed25519") },
  ] as const;
  const signatureKeyCases = signatureKeyFamilies.flatMap((keyFamily) =>
    JWK_REPRESENTATIONS.map((representation) => ({ ...keyFamily, representation })),
  );

  async function signedWriteWithResolvedKey(signingKey: KeyObject, resolvedJwk: JsonWebKey) {
    const handler = vi.fn(async () => ({
      ucp: { version: UCP_VERSION, status: "ok" as const },
      checkout: { id: "chk_signed" },
    }));
    const app = new Hono().route(
      "/ucp/v1",
      createUcpRestRoutes({
        restHandlers: { create_checkout: handler },
        signatureVerification: { keyResolver: async () => resolvedJwk },
      }),
    );
    const body = JSON.stringify({ source: { type: "cart" } });
    const response = await app.request("/ucp/v1/checkout-sessions", {
      method: "POST",
      body,
      headers: signedHeadersWithKey("POST", "/ucp/v1/checkout-sessions", body, signingKey, {
        "Idempotency-Key": "idem_signed",
      }),
    });
    return { response, handler };
  }

  it.each(signatureKeyCases)(
    "verifies $family signatures against $representation resolver JWK members",
    async ({ generate, representation }) => {
      const { privateKey, publicKey } = generate();
      const resolvedJwk = representJwk(publicKey.export({ format: "jwk" }), representation);
      const shapeBefore = jwkShape(resolvedJwk);

      const { response, handler } = await signedWriteWithResolvedKey(privateKey, resolvedJwk);

      expect(response.status).toBe(200);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(jwkShape(resolvedJwk)).toEqual(shapeBefore);
    },
  );

  it.each(signatureKeyCases)(
    "rejects $family signatures from another key against $representation resolver JWK members",
    async ({ generate, representation }) => {
      const { privateKey } = generate();
      const resolvedJwk = representJwk(generate().publicKey.export({ format: "jwk" }), representation);
      const shapeBefore = jwkShape(resolvedJwk);

      const { response, handler } = await signedWriteWithResolvedKey(privateKey, resolvedJwk);

      expect(response.status).toBe(400);
      expect(handler).not.toHaveBeenCalled();
      await expect(response.json()).resolves.toMatchObject({
        messages: [{ message: "HTTP Message Signature verification failed." }],
      });
      expect(jwkShape(resolvedJwk)).toEqual(shapeBefore);
    },
  );

  const unusableResolverJwks: readonly JsonWebKey[] = [
    { kty: "oct", k: "AAAA" },
    { kty: "EC", crv: "P-256", x: "AAAA" },
  ];

  it.each(
    unusableResolverJwks.flatMap((jwk) => JWK_REPRESENTATIONS.map((representation) => ({ jwk, representation }))),
  )(
    "reports the Node key error for unusable $jwk.kty resolver JWK members held as $representation",
    async ({ jwk, representation }) => {
      const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
      const expected = thrownBy(() => createPublicKey({ key: { ...jwk }, format: "jwk" }));
      const resolvedJwk = representJwk(jwk, representation);
      const shapeBefore = jwkShape(resolvedJwk);

      const { response, handler } = await signedWriteWithResolvedKey(privateKey, resolvedJwk);

      expect(response.status).toBe(400);
      expect(handler).not.toHaveBeenCalled();
      await expect(response.json()).resolves.toMatchObject({
        messages: [{ message: expected.message }],
      });
      expect(jwkShape(resolvedJwk)).toEqual(shapeBefore);
    },
  );

  it("rejects signed writes when created is stale", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const publicJwk = publicKey.export({ format: "jwk" });
    const handler = vi.fn(async () => ({
      ucp: { version: UCP_VERSION, status: "ok" as const },
      checkout: { id: "chk_signed" },
    }));
    const app = new Hono().route(
      "/ucp/v1",
      createUcpRestRoutes({
        restHandlers: {
          create_checkout: handler,
        },
        signatureVerification: {
          keyResolver: vi.fn(async () => publicJwk),
          now: () => new Date("2026-05-16T12:10:00.000Z"),
          createdFreshnessWindowMs: 5 * 60 * 1000,
        },
      }),
    );
    const body = JSON.stringify({ source: { type: "cart" } });

    const response = await app.request("/ucp/v1/checkout-sessions", {
      method: "POST",
      body,
      headers: signedHeadersWithKey(
        "POST",
        "/ucp/v1/checkout-sessions",
        body,
        privateKey,
        {
          "Idempotency-Key": "idem_stale",
        },
        {
          createdSeconds: Math.floor(new Date("2026-05-16T12:00:00.000Z").getTime() / 1000),
        },
      ),
    });

    expect(response.status).toBe(400);
    expect(handler).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      messages: [{ message: "Signature-Input created timestamp is outside the allowed freshness window." }],
    });
  });

  it("rejects signed writes when the idempotency key is not covered", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const publicJwk = publicKey.export({ format: "jwk" });
    const handler = vi.fn(async () => ({
      ucp: { version: UCP_VERSION, status: "ok" as const },
      checkout: { id: "chk_signed" },
    }));
    const app = new Hono().route(
      "/ucp/v1",
      createUcpRestRoutes({
        restHandlers: {
          create_checkout: handler,
        },
        signatureVerification: {
          keyResolver: vi.fn(async () => publicJwk),
        },
      }),
    );
    const body = JSON.stringify({ source: { type: "cart" } });

    const response = await app.request("/ucp/v1/checkout-sessions", {
      method: "POST",
      body,
      headers: signedHeadersWithKey(
        "POST",
        "/ucp/v1/checkout-sessions",
        body,
        privateKey,
        {
          "Idempotency-Key": "idem_unsigned",
        },
        {
          omitCoveredComponents: ["idempotency-key"],
        },
      ),
    });

    expect(response.status).toBe(400);
    expect(handler).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      messages: [{ message: "Signature-Input must cover idempotency-key for signed UCP writes." }],
    });
  });

  it("verifies RFC path and query components independently", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const publicJwk = publicKey.export({ format: "jwk" });
    const handler = vi.fn(async () => ({
      ucp: { version: UCP_VERSION, status: "ok" as const },
      checkout: { id: "chk_query" },
    }));
    const app = new Hono().route(
      "/ucp/v1",
      createUcpRestRoutes({
        restHandlers: {
          create_checkout: handler,
        },
        signatureVerification: {
          keyResolver: vi.fn(async () => publicJwk),
        },
      }),
    );
    const body = JSON.stringify({ source: { type: "cart" } });

    const response = await app.request("/ucp/v1/checkout-sessions?source=agent", {
      method: "POST",
      body,
      headers: signedHeadersWithKey("POST", "/ucp/v1/checkout-sessions?source=agent", body, privateKey, {
        "Idempotency-Key": "idem_query",
      }),
    });

    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    await expect(response.json()).resolves.toMatchObject({
      checkout: { id: "chk_query" },
    });
  });

  it("rejects checkout completion without an idempotency key before invoking handlers", async () => {
    const handler = vi.fn();
    const app = new Hono().route(
      "/ucp/v1",
      createUcpRestRoutes({
        restHandlers: {
          complete_checkout: handler,
        },
      }),
    );
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
    const app = new Hono().route(
      "/ucp/v1",
      createUcpRestRoutes({
        restHandlers: {
          create_checkout: handler,
        },
      }),
    );

    const response = await app.request("/ucp/v1/checkout-sessions", {
      method: "POST",
      body: '{"changed":true}',
      headers: signedHeaders("{}", { "Idempotency-Key": "idem_1" }),
    });

    expect(handler).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      messages: [{ code: "signed_request_required" }],
    });
  });
});

describe("UCP profile key cache", () => {
  it("uses argument retry keys for signed MCP writes and replays the equivalent header retry", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const handler = vi.fn(() => createUcpEnvelope("ok", { checkout: { id: "checkout_1" } }));
    const app = new Hono().route(
      "/ucp/mcp",
      createUcpMcpRoutes({
        mcpToolHandlers: { complete_checkout: handler },
        signatureVerification: { keyResolver: () => publicKey.export({ format: "jwk" }) },
      }),
    );
    for (const location of ["argument", "header"]) {
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: location,
        method: "tools/call",
        params: {
          name: "complete_checkout",
          arguments: {
            id: "checkout_1",
            meta: {
              "ucp-agent": { profile: "https://agent.example/.well-known/ucp" },
              ...(location === "argument" ? { "idempotency-key": "shared_retry" } : {}),
            },
          },
        },
      });
      const response = await app.request("/ucp/mcp", {
        method: "POST",
        body,
        headers: signedHeadersWithKey(
          "POST",
          "/ucp/mcp",
          body,
          privateKey,
          location === "header" ? { "Idempotency-Key": "shared_retry" } : {},
        ),
      });
      expect((await response.json()).result.structuredContent.ucp.status).toBe("ok");
    }
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ arguments: { id: "checkout_1" } }));
  });

  it("shares one fetch between negotiation and signed-write key resolution", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const profile = {
      ...testPlatformProfile,
      signing_keys: [{ ...publicKey.export({ format: "jwk" }), kid: "platform-2026" }],
    };
    const fetch = vi.fn(async () => Response.json(profile));
    const profileResolver = createUcpProfileResolver({
      db: createFakeProfileDb(),
      fetch,
      lookup: async () => [{ address: "8.8.8.8", family: 4 }],
    });
    const handler = vi.fn(() => createUcpEnvelope("ok", {}));
    const app = new Hono().route(
      "/ucp/v1",
      buildUcpRestRoutes({
        profileResolver,
        restHandlers: { create_checkout: handler },
        signatureVerification: { keyResolver: createUcpProfileKeyResolver(profileResolver) },
      }),
    );
    const body = "{}";
    const response = await app.request("/ucp/v1/checkout-sessions", {
      method: "POST",
      body,
      headers: signedHeadersWithKey("POST", "/ucp/v1/checkout-sessions", body, privateKey, {
        "Idempotency-Key": "shared_fetch",
      }),
    });
    expect(response.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("caches fetched agent signing keys in the platform store", async () => {
    const db = createFakeProfileDb();
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ...testPlatformProfile,
            signing_keys: [{ kid: "platform-2026", kty: "RSA", n: "abc", e: "AQAB" }],
          }),
          { status: 200 },
        ),
    );
    const profileResolver = createUcpProfileResolver({
      db,
      fetch,
      lookup: async () => [{ address: "8.8.8.8", family: 4 }],
      now: () => new Date("2026-05-16T00:00:00.000Z"),
    });
    const resolver = createUcpProfileKeyResolver(profileResolver);

    const first = await resolver("https://agent.example/.well-known/ucp", "platform-2026");
    const second = await resolver("https://agent.example/.well-known/ucp", "platform-2026");

    expect(first).toMatchObject({ kid: "platform-2026" });
    expect(second).toMatchObject({ kid: "platform-2026" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("ucp negotiates platform profiles before effects", () => {
  it.each(["rest", "mcp"] as const)(
    "rejects another OAuth platform profile in either location on %s",
    async (transport) => {
      for (const ownProfile of [true, false]) {
        for (const location of ["header", "argument"] as const) {
          if (transport === "rest" && location === "argument") continue;
          const handler = vi.fn(() => createUcpEnvelope("ok", {}));
          const reserve = vi.fn();
          const negotiationRejected = vi.fn();
          const app = new Hono<{ Variables: { actor: ResolvedActor | null } }>();
          app.use("*", async (c, next) => {
            c.set("actor", {
              sessionId: "ucp:binding",
              tenantId: "tnt_1",
              userId: "usr_1",
              accountId: "acc_1",
              membershipId: "mem_1",
              roleKey: "buyer",
              permissions: [],
              agentGrant: {
                grantId: "binding",
                platformProfileUrl: ownProfile
                  ? "https://agent.example/.well-known/ucp"
                  : "https://other.example/profile",
                scopes: ["dev.ucp.shopping.checkout:manage"],
                rolePermissions: [],
              },
            });
            await next();
          });
          const options: CreateUcpRoutesOptions = {
            profileResolver: resolveTestProfile,
            observer: { negotiationRejected },
            restHandlers: { get_checkout: handler },
            mcpToolHandlers: { get_checkout: handler },
            idempotencyStore: { reserve, get: vi.fn(), complete: vi.fn(), abandon: vi.fn(), put: vi.fn() },
          };
          app.route("/ucp/v1", buildUcpRestRoutes(options));
          app.route("/ucp/mcp", buildUcpMcpRoutes(options));
          const response = await app.request(
            transport === "rest" ? "/ucp/v1/checkout-sessions/checkout_1" : "/ucp/mcp",
            {
              method: transport === "rest" ? "GET" : "POST",
              headers: {
                "Content-Type": "application/json",
                ...(location === "header" ? { "UCP-Agent": 'profile="https://agent.example/.well-known/ucp"' } : {}),
              },
              ...(transport === "mcp"
                ? {
                    body: JSON.stringify({
                      jsonrpc: "2.0",
                      id: 1,
                      method: "tools/call",
                      params: {
                        name: "get_checkout",
                        arguments: {
                          id: "checkout_1",
                          ...(location === "argument"
                            ? { meta: { "ucp-agent": { profile: "https://agent.example/.well-known/ucp" } } }
                            : {}),
                        },
                      },
                    }),
                  }
                : {}),
            },
          );
          const result = await response.json();
          if (ownProfile) {
            expect(handler).toHaveBeenCalledTimes(1);
            expect(negotiationRejected).not.toHaveBeenCalled();
          } else {
            expect(transport === "rest" ? result.messages[0].code : result.error.data.code).toBe("profile_mismatch");
            expect(transport === "rest" ? response.status : result.error.code).toBe(
              transport === "rest" ? 403 : -32000,
            );
            expect(handler).not.toHaveBeenCalled();
            expect(negotiationRejected).toHaveBeenCalledExactlyOnceWith({
              transport,
              operation: "get_checkout",
              code: "profile_mismatch",
              profileHost: "agent.example",
            });
          }
          expect(reserve).not.toHaveBeenCalled();
        }
      }
    },
  );

  it.each(["rest", "mcp"] as const)("rejects an incompatible capability with no effect on %s", async (transport) => {
    const handler = vi.fn(() => createUcpEnvelope("ok", {}));
    const negotiationRejected = vi.fn();
    const options: CreateUcpRoutesOptions = {
      observer: { negotiationRejected },
      profileResolver: async () => ({
        ok: true,
        profile: { ucp: { version: UCP_VERSION, services: {}, payment_handlers: {}, capabilities: {} } },
      }),
      restHandlers: { search_catalog: handler },
      mcpToolHandlers: { search_catalog: handler },
    };
    const app = new Hono().route("/ucp/v1", buildUcpRestRoutes(options)).route("/ucp/mcp", buildUcpMcpRoutes(options));
    const response = await app.request(transport === "rest" ? "/ucp/v1/catalog/search" : "/ucp/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", "UCP-Agent": 'profile="https://agent.example/.well-known/ucp"' },
      body:
        transport === "rest"
          ? "{}"
          : JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: { name: "search_catalog", arguments: {} },
            }),
    });
    const result = await response.json();
    expect(response.status).toBe(200);
    expect((transport === "rest" ? result : result.result.structuredContent).messages[0].code).toBe(
      "capabilities_incompatible",
    );
    expect(handler).not.toHaveBeenCalled();
    expect(negotiationRejected).toHaveBeenCalledExactlyOnceWith({
      transport,
      operation: "search_catalog",
      code: "capabilities_incompatible",
      profileHost: "agent.example",
    });
  });

  it.each(["rest", "mcp"] as const)(
    "signals version rejection without leaking profile URL or secrets on %s",
    async (transport) => {
      const negotiationRejected = vi.fn();
      const handler = vi.fn();
      const reserve = vi.fn();
      const options: CreateUcpRoutesOptions = {
        profileResolver: async () => ({
          ok: true,
          profile: { ...testPlatformProfile, ucp: { ...testPlatformProfile.ucp, version: "1900-01-01" } },
        }),
        observer: { negotiationRejected },
        restHandlers: { get_checkout: handler },
        mcpToolHandlers: { get_checkout: handler },
        idempotencyStore: { reserve, get: vi.fn(), complete: vi.fn(), abandon: vi.fn(), put: vi.fn() },
      };
      const app = new Hono()
        .route("/ucp/v1", buildUcpRestRoutes(options))
        .route("/ucp/mcp", buildUcpMcpRoutes(options));
      const bytes: string[] = [];
      for (const token of ["valid-secret", "invalid-secret", ""]) {
        const response = await app.request(transport === "rest" ? "/ucp/v1/checkout-sessions/checkout_1" : "/ucp/mcp", {
          method: transport === "rest" ? "GET" : "POST",
          headers: {
            "Content-Type": "application/json",
            "UCP-Agent": 'profile="https://agent.example/private-path?secret=profile-secret"',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          ...(transport === "mcp"
            ? {
                body: JSON.stringify({
                  jsonrpc: "2.0",
                  id: 1,
                  method: "tools/call",
                  params: { name: "get_checkout", arguments: {} },
                }),
              }
            : {}),
        });
        expect(response.status).toBe(transport === "rest" ? 422 : 200);
        bytes.push(await response.text());
      }
      expect(new Set(bytes).size).toBe(1);
      expect(negotiationRejected).toHaveBeenCalledTimes(3);
      for (const [event] of negotiationRejected.mock.calls) {
        expect(event).toEqual({
          transport,
          operation: "get_checkout",
          code: "version_unsupported",
          profileHost: "agent.example",
        });
      }
      expect(handler).not.toHaveBeenCalled();
      expect(reserve).not.toHaveBeenCalled();
    },
  );

  it.each([
    { meta: { "ucp-agent": "x" }, code: "invalid_profile_url", profileHost: null },
    {
      meta: {
        "ucp-agent": { profile: "https://agent.example/private-path?secret=profile-secret" },
        "idempotency-key": "argument-secret",
      },
      code: "idempotency_key_mismatch",
      profileHost: "agent.example",
    },
  ])("signals MCP $code without raw values", async ({ meta, code, profileHost }) => {
    const negotiationRejected = vi.fn();
    const handler = vi.fn();
    const reserve = vi.fn();
    const options: CreateUcpRoutesOptions = {
      profileResolver: resolveTestProfile,
      observer: { negotiationRejected },
      restHandlers: { get_checkout: handler },
      mcpToolHandlers: { get_checkout: handler },
      idempotencyStore: { reserve, get: vi.fn(), complete: vi.fn(), abandon: vi.fn(), put: vi.fn() },
    };
    const app = new Hono().route("/ucp/v1", buildUcpRestRoutes(options)).route("/ucp/mcp", buildUcpMcpRoutes(options));
    const response = await app.request("/ucp/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "header-secret" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "get_checkout", arguments: { meta, id: "checkout_1" } },
      }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).error.data.code).toBe(code);
    expect(negotiationRejected).toHaveBeenCalledExactlyOnceWith({
      transport: "mcp",
      operation: "get_checkout",
      code,
      profileHost,
    });
    expect(Object.values(negotiationRejected.mock.calls[0][0])).not.toContain("x");
    expect(handler).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
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
      status: "completed",
      createdAt: "2026-05-16T12:00:00.000Z",
    });

    await expect(store.get("idem_1")).resolves.toBeNull();
    await expect(store.pruneExpired?.()).resolves.toBe(1);
  });

  it("reserves pending writes before completing or abandoning them", async () => {
    const db = createFakeIdempotencyDb();
    const store = createPostgresUcpIdempotencyStore(db, {
      pendingTtlMs: 30_000,
      retentionMs: 60_000,
    });

    const reserved = await store.reserve({
      key: "idem_pending",
      requestHash: "hash_1",
      createdAt: "2099-05-16T12:00:00.000Z",
    });
    const duplicate = await store.reserve({
      key: "idem_pending",
      requestHash: "hash_1",
      createdAt: "2099-05-16T12:00:01.000Z",
    });
    const conflict = await store.reserve({
      key: "idem_pending",
      requestHash: "hash_2",
      createdAt: "2099-05-16T12:00:02.000Z",
    });

    expect(reserved.outcome).toBe("reserved");
    expect(duplicate.outcome).toBe("pending");
    expect(conflict.outcome).toBe("conflict");

    if (reserved.outcome !== "reserved") {
      throw new Error("Expected the first idempotency call to reserve the key.");
    }
    await store.complete({
      ...reserved.record,
      response: { ucp: { version: UCP_VERSION, status: "ok" } },
    });
    await expect(
      store.reserve({
        key: "idem_pending",
        requestHash: "hash_1",
        createdAt: "2099-05-16T12:00:03.000Z",
      }),
    ).resolves.toMatchObject({
      outcome: "completed",
      record: { response: { ucp: { status: "ok" } } },
    });

    const abandoned = await store.reserve({
      key: "idem_abandon",
      requestHash: "hash_3",
      createdAt: "2099-05-16T12:00:04.000Z",
    });
    expect(abandoned.outcome).toBe("reserved");
    await store.abandon({ key: "idem_abandon", requestHash: "hash_3" });
    await expect(
      store.reserve({
        key: "idem_abandon",
        requestHash: "hash_3",
        createdAt: "2099-05-16T12:00:05.000Z",
      }),
    ).resolves.toMatchObject({ outcome: "reserved" });
  });
});

describe("UCP MCP routes", () => {
  const modernMeta = {
    [MCP_META_PROTOCOL_VERSION_KEY]: "2026-07-28",
    [MCP_META_CLIENT_CAPABILITIES_KEY]: {},
  };
  const serverInfo = { name: "chase-sets-ucp", title: "Chase Sets UCP", version: "0.1.0" };
  const modernHeaders = (method: string, name?: string) => ({
    "Content-Type": "application/json",
    [MCP_PROTOCOL_VERSION_HEADER]: "2026-07-28",
    [MCP_METHOD_HEADER]: method,
    ...(name === undefined ? {} : { [MCP_NAME_HEADER]: name }),
  });

  it("UCP MCP 2026-07-28 stateless scripted HTTP client without initialize", async () => {
    const handler = vi.fn(() => ({ ucp: { version: UCP_VERSION, status: "ok" as const }, products: [] }));
    const app = new Hono().route("/ucp/mcp", createUcpMcpRoutes({ mcpToolHandlers: { search_catalog: handler } }));
    // Raw JSON-RPC fetch adapter: the pinned SDK supports legacy revisions only.
    const scriptedFetch: typeof fetch = async (input, init) => app.request(new Request(input, init));
    const calls = [
      { method: "server/discover", params: {}, name: undefined },
      { method: "tools/list", params: {}, name: undefined },
      {
        method: "tools/call",
        params: { name: "search_catalog", arguments: { query: "charizard", limit: 3 } },
        name: "search_catalog",
      },
      {
        method: "resources/read",
        params: { uri: UCP_MCP_PRODUCT_CARDS_RESOURCE_URI },
        name: UCP_MCP_PRODUCT_CARDS_RESOURCE_URI,
      },
    ];
    for (const call of calls) {
      const response = await scriptedFetch("https://marketplace.example/ucp/mcp", {
        method: "POST",
        headers: modernHeaders(call.method, call.name),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: call.method,
          method: call.method,
          params: { ...call.params, _meta: modernMeta },
        }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("Mcp-Session-Id")).toBeNull();
      const body = await response.json();
      expect(body).toMatchObject({
        jsonrpc: "2.0",
        id: call.method,
        result: { _meta: { "io.modelcontextprotocol/serverInfo": serverInfo } },
      });
      if (call.method === "server/discover") {
        expect(body.result).toEqual({
          supportedVersions: ["2026-07-28", "2025-11-25", "2025-06-18"],
          capabilities: { tools: {}, resources: {} },
          _meta: { "io.modelcontextprotocol/serverInfo": serverInfo },
        });
      } else if (call.method === "tools/list") {
        expect(body.result.tools.map((tool: { name: string }) => tool.name)).toEqual(
          UCP_MCP_TOOLS.map((tool) => tool.name),
        );
      } else if (call.method === "tools/call") {
        expect(body.result.structuredContent).toEqual({ ucp: { version: UCP_VERSION, status: "ok" }, products: [] });
        expect(body.result._meta.ui.resourceUri).toBe(UCP_MCP_PRODUCT_CARDS_RESOURCE_URI);
      } else {
        expect(body.result.contents[0]).toMatchObject({
          uri: UCP_MCP_PRODUCT_CARDS_RESOURCE_URI,
          mimeType: "text/html;profile=mcp-app",
        });
      }
    }
    expect(handler).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ arguments: { query: "charizard", limit: 3 } }),
    );
  });

  describe("UCP MCP era matrix", () => {
    it.each([
      {
        method: "resources/read",
        params: { uri: UCP_MCP_PRODUCT_CARDS_RESOURCE_URI },
        name: `=?base64?${Buffer.from(UCP_MCP_PRODUCT_CARDS_RESOURCE_URI).toString("base64")}?=`,
        status: 200,
        code: undefined,
      },
      {
        method: "resources/read",
        params: { uri: UCP_MCP_CART_REVIEW_RESOURCE_URI },
        name: undefined,
        status: 400,
        code: -32020,
      },
      { method: "tools/call", params: {}, name: undefined, status: 400, code: -32020 },
      { method: "prompts/get", params: { name: "prompt" }, name: "other", status: 400, code: -32020 },
      ...[" padded ", "\uFEFFtarget", "\u4E16\u754C"].map((name) => ({
        method: "tools/call",
        params: { name },
        name: `=?base64?${Buffer.from(name).toString("base64")}?=`,
        status: 200,
        code: -32602,
      })),
    ])("target encoding and routing $method $name", async (row) => {
      const app = new Hono().route("/ucp/mcp", createUcpMcpRoutes());
      const response = await app.request("/ucp/mcp", {
        method: "POST",
        headers: modernHeaders(row.method, row.name),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "target",
          method: row.method,
          params: { ...row.params, _meta: modernMeta },
        }),
      });
      expect(response.status).toBe(row.status);
      const body = await response.json();
      expect(body.error?.code).toBe(row.code);
      if (row.method === "resources/read" && row.status === 200) {
        expect(body.result.contents[0].uri).toBe(UCP_MCP_PRODUCT_CARDS_RESOURCE_URI);
      }
    });

    const headers = modernHeaders("tools/call", "search_catalog");
    const rows: readonly {
      name: string;
      method?: string;
      headers: Readonly<Record<string, string>>;
      meta: Readonly<Record<string, unknown>>;
      status: number;
      code: number | undefined;
    }[] = [
      { name: "modern without optional clientInfo", headers, meta: modernMeta, status: 200, code: undefined },
      {
        name: "unsupported metadata",
        headers: { ...headers, [MCP_PROTOCOL_VERSION_HEADER]: "1900-01-01" },
        meta: { ...modernMeta, [MCP_META_PROTOCOL_VERSION_KEY]: "1900-01-01" },
        status: 400,
        code: -32022,
      },
      {
        name: "unsupported metadata before missing header",
        headers: { [MCP_METHOD_HEADER]: "tools/call" },
        meta: { ...modernMeta, [MCP_META_PROTOCOL_VERSION_KEY]: "1800-01-01" },
        status: 400,
        code: -32022,
      },
      {
        name: "missing protocol header",
        headers: { [MCP_METHOD_HEADER]: "tools/call", [MCP_NAME_HEADER]: "search_catalog" },
        meta: modernMeta,
        status: 400,
        code: -32020,
      },
      {
        name: "different protocol header",
        headers: { ...headers, [MCP_PROTOCOL_VERSION_HEADER]: "2025-11-25" },
        meta: modernMeta,
        status: 400,
        code: -32020,
      },
      {
        name: "missing method",
        headers: { [MCP_PROTOCOL_VERSION_HEADER]: "2026-07-28", [MCP_NAME_HEADER]: "search_catalog" },
        meta: modernMeta,
        status: 400,
        code: -32020,
      },
      {
        name: "mismatched method",
        headers: { ...headers, [MCP_METHOD_HEADER]: "resources/read" },
        meta: modernMeta,
        status: 400,
        code: -32020,
      },
      { name: "missing name", headers: modernHeaders("tools/call"), meta: modernMeta, status: 400, code: -32020 },
      {
        name: "mismatched name",
        headers: { ...headers, [MCP_NAME_HEADER]: "lookup_catalog" },
        meta: modernMeta,
        status: 400,
        code: -32020,
      },
      {
        name: "encoded matching name",
        headers: { ...headers, [MCP_NAME_HEADER]: "=?base64?c2VhcmNoX2NhdGFsb2c=?=" },
        meta: modernMeta,
        status: 200,
        code: undefined,
      },
      ...["=?base64?%%%?=", "=?base64?c2VhcmNoX2NhdGFsb2c=?", "=?base64?/w==?=", "=?base64?c2VhcmNoX2NhdGFsb2d=?="].map(
        (value) => ({
          name: `malformed encoding ${value}`,
          headers: { ...headers, [MCP_NAME_HEADER]: value },
          meta: modernMeta,
          status: 400,
          code: -32020,
        }),
      ),
      {
        name: "missing capabilities",
        headers,
        meta: { [MCP_META_PROTOCOL_VERSION_KEY]: "2026-07-28" },
        status: 400,
        code: -32602,
      },
      {
        name: "capability header ignored",
        headers: { ...headers, "Mcp-Client-Capabilities": "{}" },
        meta: { [MCP_META_PROTOCOL_VERSION_KEY]: "2026-07-28" },
        status: 400,
        code: -32602,
      },
      {
        name: "invalid capabilities",
        headers,
        meta: { ...modernMeta, [MCP_META_CLIENT_CAPABILITIES_KEY]: [] },
        status: 400,
        code: -32602,
      },
      ...[null, 7, ""].map((value) => ({
        name: `invalid metadata version ${value}`,
        headers,
        meta: { ...modernMeta, [MCP_META_PROTOCOL_VERSION_KEY]: value },
        status: 400,
        code: -32602,
      })),
      {
        name: "unknown method",
        method: "unknown/method",
        headers: modernHeaders("unknown/method"),
        meta: modernMeta,
        status: 404,
        code: -32601,
      },
    ];
    it.each(rows)("$name", async (row) => {
      const handler = vi.fn(() => ({ ucp: { version: UCP_VERSION, status: "ok" as const } }));
      const app = new Hono().route("/ucp/mcp", createUcpMcpRoutes({ mcpToolHandlers: { search_catalog: handler } }));
      const response = await app.request("/ucp/mcp", {
        method: "POST",
        headers: row.headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "matrix",
          method: row.method ?? "tools/call",
          params: { name: "search_catalog", arguments: { query: "pikachu" }, _meta: row.meta },
        }),
      });
      expect(response.status).toBe(row.status);
      const body = await response.json();
      expect(body.error?.code).toBe(row.code);
      expect(handler).toHaveBeenCalledTimes(row.status === 200 ? 1 : 0);
      if (row.code === -32022) {
        expect(body.error.data).toEqual({
          supported: ["2026-07-28", "2025-11-25", "2025-06-18"],
          requested: row.meta[MCP_META_PROTOCOL_VERSION_KEY],
        });
      }
    });
  });

  describe("UCP MCP legacy fallback preserved", () => {
    const initializeResult = (protocolVersion: string) => ({
      protocolVersion,
      serverInfo,
      capabilities: { tools: {}, resources: {} },
    });
    const rows = [
      {
        name: "absent header",
        header: undefined,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
        status: 200,
        result: initializeResult("2025-06-18"),
      },
      ...["2025-06-18", "2025-11-25"].map((version) => ({
        name: `legacy header ${version}`,
        header: version,
        method: "initialize",
        params: { protocolVersion: version },
        status: 200,
        result: initializeResult(version),
      })),
      {
        name: "initialize naming modern downgrades",
        header: undefined,
        method: "initialize",
        params: { protocolVersion: "2026-07-28" },
        status: 200,
        result: initializeResult("2025-06-18"),
      },
      {
        name: "initialize selects legacy despite metadata",
        header: undefined,
        method: "initialize",
        params: { protocolVersion: "2026-07-28", _meta: modernMeta },
        status: 200,
        result: initializeResult("2025-06-18"),
      },
      {
        name: "legacy ignores routing and non-version metadata",
        header: "2025-11-25",
        method: "initialize",
        params: { protocolVersion: "2025-11-25", _meta: { [MCP_META_CLIENT_CAPABILITIES_KEY]: [] } },
        status: 200,
        result: initializeResult("2025-11-25"),
      },
      ...["2026-07-28", "1900-01-01"].map((version) => ({
        name: `header-only ${version}`,
        header: version,
        method: "tools/list",
        params: {},
        status: 400,
        error: {
          code: -32004,
          message: `Unsupported MCP protocol version '${version}'.`,
          data: { requestedVersion: version, supportedVersions: ["2025-06-18", "2025-11-25"] },
        },
      })),
      {
        name: "legacy discover remains unknown",
        header: undefined,
        method: "server/discover",
        params: {},
        status: 200,
        error: { code: -32601, message: "Unsupported UCP MCP method 'server/discover'." },
      },
    ];
    it.each(rows)("$name", async (row) => {
      const app = new Hono().route("/ucp/mcp", createUcpMcpRoutes());
      const response = await app.request("/ucp/mcp", {
        method: "POST",
        headers: {
          [MCP_METHOD_HEADER]: "ignored-legacy",
          [MCP_NAME_HEADER]: "ignored-legacy",
          ...(row.header === undefined ? {} : { [MCP_PROTOCOL_VERSION_HEADER]: row.header }),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: "legacy", method: row.method, params: row.params }),
      });
      expect(response.status).toBe(row.status);
      expect(await response.text()).toBe(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "legacy",
          ...("result" in row ? { result: row.result } : { error: row.error }),
        }),
      );
    });
  });

  it("negotiates the UCP MCP protocol version on initialize", async () => {
    const app = new Hono().route("/ucp/mcp", createUcpMcpRoutes());

    const supportedResponse = await app.request("/ucp/mcp", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "supported",
        method: "initialize",
        params: { protocolVersion: MCP_PROTOCOL_VERSION },
      }),
    });
    const unsupportedResponse = await app.request("/ucp/mcp", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "unsupported",
        method: "initialize",
        params: { protocolVersion: "2025-03-26" },
      }),
    });
    const futureRevisionResponse = await app.request("/ucp/mcp", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "future-revision",
        method: "initialize",
        params: { protocolVersion: MCP_PROTOCOL_VERSION_2025_11_25 },
      }),
    });

    expect(MCP_LEGACY_PROTOCOL_VERSIONS).toEqual([MCP_PROTOCOL_VERSION, MCP_PROTOCOL_VERSION_2025_11_25]);
    expect(supportedResponse.status).toBe(200);
    await expect(supportedResponse.json()).resolves.toMatchObject({
      id: "supported",
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        serverInfo: {
          name: "chase-sets-ucp",
        },
      },
    });
    expect(unsupportedResponse.status).toBe(200);
    await expect(unsupportedResponse.json()).resolves.toMatchObject({
      id: "unsupported",
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
      },
    });
    expect(futureRevisionResponse.status).toBe(200);
    await expect(futureRevisionResponse.json()).resolves.toMatchObject({
      id: "future-revision",
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION_2025_11_25,
      },
    });
  });

  it("honors supported MCP protocol headers and rejects unsupported revisions", async () => {
    const app = new Hono().route("/ucp/mcp", createUcpMcpRoutes());

    const supportedHeaderResponse = await app.request("/ucp/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [MCP_PROTOCOL_VERSION_HEADER]: MCP_PROTOCOL_VERSION_2025_11_25,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: "tools", method: "tools/list" }),
    });
    const unsupportedHeaderResponse = await app.request("/ucp/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [MCP_PROTOCOL_VERSION_HEADER]: "2026-07-28",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: "tools", method: "tools/list" }),
    });

    expect(supportedHeaderResponse.status).toBe(200);
    await expect(supportedHeaderResponse.json()).resolves.toMatchObject({
      result: {
        tools: expect.arrayContaining([expect.objectContaining({ name: "search_catalog" })]),
      },
    });
    expect(unsupportedHeaderResponse.status).toBe(400);
    await expect(unsupportedHeaderResponse.json()).resolves.toMatchObject({
      error: {
        code: -32004,
        data: {
          requestedVersion: "2026-07-28",
          supportedVersions: [MCP_PROTOCOL_VERSION, MCP_PROTOCOL_VERSION_2025_11_25],
        },
      },
    });
  });

  it("rejects hostile browser origins and emits CORS headers for allowed UCP MCP origins", async () => {
    const app = new Hono().route("/ucp/mcp", createUcpMcpRoutes());

    const hostileResponse = await app.request("https://marketplace.chasesets.test/ucp/mcp", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: "tools", method: "tools/list" }),
      headers: {
        "Content-Type": "application/json",
        Origin: "https://evil.example",
      },
    });
    const preflightResponse = await app.request("https://marketplace.chasesets.test/ucp/mcp", {
      method: "OPTIONS",
      headers: {
        Origin: "https://marketplace.chasesets.test",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": `Content-Type, ${MCP_PROTOCOL_VERSION_HEADER}`,
      },
    });
    const allowedResponse = await app.request("https://marketplace.chasesets.test/ucp/mcp", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: "tools", method: "tools/list" }),
      headers: {
        "Content-Type": "application/json",
        Origin: "https://marketplace.chasesets.test",
      },
    });

    expect(hostileResponse.status).toBe(403);
    await expect(hostileResponse.json()).resolves.toMatchObject({
      error: {
        code: -32003,
        message: "Invalid Origin header for MCP endpoint.",
      },
    });
    expect(preflightResponse.status).toBe(204);
    expect(preflightResponse.headers.get("Access-Control-Allow-Origin")).toBe("https://marketplace.chasesets.test");
    expect(preflightResponse.headers.get("Access-Control-Allow-Headers")).toContain(MCP_PROTOCOL_VERSION_HEADER);
    expect(allowedResponse.status).toBe(200);
    expect(allowedResponse.headers.get("Access-Control-Allow-Origin")).toBe("https://marketplace.chasesets.test");
  });

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
    expect(body.result.tools[0]).toMatchObject({
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      securitySchemes: [{ type: "noauth" }],
      annotations: {
        readOnlyHint: true,
      },
      _meta: {
        securitySchemes: [{ type: "noauth" }],
        ui: {
          resourceUri: UCP_MCP_PRODUCT_CARDS_RESOURCE_URI,
        },
        "openai/outputTemplate": UCP_MCP_PRODUCT_CARDS_RESOURCE_URI,
      },
    });
  });

  it("lists and reads the MCP Apps widget resources", async () => {
    const app = new Hono().route("/ucp/mcp", createUcpMcpRoutes());

    const listResponse = await app.request("/ucp/mcp", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: "1", method: "resources/list" }),
    });
    const readResponse = await app.request("/ucp/mcp", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "2",
        method: "resources/read",
        params: {
          uri: UCP_MCP_PRODUCT_CARDS_RESOURCE_URI,
        },
      }),
    });
    const cartReadResponse = await app.request("/ucp/mcp", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "3",
        method: "resources/read",
        params: {
          uri: UCP_MCP_CART_REVIEW_RESOURCE_URI,
        },
      }),
    });
    const handoffReadResponse = await app.request("/ucp/mcp", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "4",
        method: "resources/read",
        params: {
          uri: UCP_MCP_CHECKOUT_HANDOFF_RESOURCE_URI,
        },
      }),
    });

    expect(listResponse.status).toBe(200);
    const listBody = await listResponse.json();
    expect(listBody.result.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ uri: UCP_MCP_PRODUCT_CARDS_RESOURCE_URI, mimeType: "text/html;profile=mcp-app" }),
        expect.objectContaining({ uri: UCP_MCP_CART_REVIEW_RESOURCE_URI, mimeType: "text/html;profile=mcp-app" }),
        expect.objectContaining({ uri: UCP_MCP_CHECKOUT_HANDOFF_RESOURCE_URI, mimeType: "text/html;profile=mcp-app" }),
      ]),
    );
    expect(readResponse.status).toBe(200);
    await expect(readResponse.json()).resolves.toMatchObject({
      result: {
        contents: [
          {
            uri: UCP_MCP_PRODUCT_CARDS_RESOURCE_URI,
            mimeType: "text/html;profile=mcp-app",
            text: expect.stringContaining("Chase Sets Product Cards"),
            _meta: {
              "openai/widgetCSP": {
                connect_domains: [],
                resource_domains: [],
              },
              "openai/widgetDescription": "Interactive Chase Sets product cards from marketplace listing search.",
              "openai/widgetPrefersBorder": true,
            },
          },
        ],
      },
    });
    const productCardsBody = await app.request("/ucp/mcp", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "5",
        method: "resources/read",
        params: {
          uri: UCP_MCP_PRODUCT_CARDS_RESOURCE_URI,
        },
      }),
    });
    const productCardsJson = await productCardsBody.json();
    expect(productCardsJson.result.contents[0].text).not.toContain("<img");
    expect(cartReadResponse.status).toBe(200);
    await expect(cartReadResponse.json()).resolves.toMatchObject({
      result: {
        contents: [
          {
            uri: UCP_MCP_CART_REVIEW_RESOURCE_URI,
            text: expect.stringContaining("Chase Sets Cart Review"),
          },
        ],
      },
    });
    expect(handoffReadResponse.status).toBe(200);
    await expect(handoffReadResponse.json()).resolves.toMatchObject({
      result: {
        contents: [
          {
            uri: UCP_MCP_CHECKOUT_HANDOFF_RESOURCE_URI,
            text: expect.stringContaining("Chase Sets Checkout Handoff"),
          },
        ],
      },
    });
  });

  it("rejects UCP MCP JSON-RPC batches as transport-level invalid requests", async () => {
    const app = new Hono().route("/ucp/mcp", createUcpMcpRoutes());

    const response = await app.request("/ucp/mcp", {
      method: "POST",
      body: JSON.stringify([{ jsonrpc: "2.0", id: "1", method: "tools/list" }]),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32600,
        message: "JSON-RPC batch requests are not supported.",
      },
    });
  });

  it("returns UCP MCP protocol errors in-band with HTTP 200", async () => {
    const app = new Hono().route("/ucp/mcp", createUcpMcpRoutes());

    const unknownTool = await app.request("/ucp/mcp", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "tool",
        method: "tools/call",
        params: { name: "missing_tool" },
      }),
    });
    const unknownResource = await app.request("/ucp/mcp", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "resource",
        method: "resources/read",
        params: { uri: "ui://missing/resource.html" },
      }),
    });
    const unsupportedMethod = await app.request("/ucp/mcp", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "method",
        method: "prompts/list",
      }),
    });

    expect(unknownTool.status).toBe(200);
    await expect(unknownTool.json()).resolves.toMatchObject({
      id: "tool",
      error: {
        code: -32602,
        message: "Unknown UCP MCP tool 'missing_tool'.",
      },
    });
    expect(unknownResource.status).toBe(200);
    await expect(unknownResource.json()).resolves.toMatchObject({
      id: "resource",
      error: {
        code: -32602,
        message: "Unknown UCP MCP resource 'ui://missing/resource.html'.",
      },
    });
    expect(unsupportedMethod.status).toBe(200);
    await expect(unsupportedMethod.json()).resolves.toMatchObject({
      id: "method",
      error: {
        code: -32601,
        message: "Unsupported UCP MCP method 'prompts/list'.",
      },
    });
  });

  it.each(["legacy", "modern"])("requires idempotency for complete_checkout tool calls (%s)", async (era) => {
    const handler = vi.fn();
    const app = new Hono().route("/ucp/mcp", createUcpMcpRoutes({ mcpToolHandlers: { complete_checkout: handler } }));
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: "1",
      method: "tools/call",
      params: {
        name: "complete_checkout",
        arguments: { id: "chk_1" },
        ...(era === "modern" ? { _meta: modernMeta } : {}),
      },
    });

    const response = await app.request("/ucp/mcp", {
      method: "POST",
      body,
      headers: signedHeaders(body, era === "modern" ? modernHeaders("tools/call", "complete_checkout") : {}),
    });

    expect(response.status).toBe(200);
    expect(handler).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      error: {
        message: "Idempotency-Key is required for complete_checkout.",
      },
    });
  });

  it("limits UCP MCP tool calls before invoking handlers and emits observer evidence", async () => {
    const handler = vi.fn();
    const limitedEvents: unknown[] = [];
    const app = new Hono().route(
      "/ucp/mcp",
      createUcpMcpRoutes({
        mcpToolHandlers: {
          search_catalog: handler,
        },
        mcpToolCallLimiter: {
          acquire: vi.fn(async () => ({
            allowed: false as const,
            reason: "Too many MCP tool calls are already running for this principal.",
          })),
        },
        observer: {
          toolCallLimited: (event) => limitedEvents.push(event),
        },
      }),
    );

    const response = await app.request("/ucp/mcp", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "limited",
        method: "tools/call",
        params: {
          name: "search_catalog",
          arguments: { query: "charizard" },
        },
      }),
      headers: { "Content-Type": "application/json" },
    });

    expect(response.status).toBe(200);
    expect(handler).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      id: "limited",
      result: {
        structuredContent: {
          ucp: {
            status: "error",
          },
          messages: [
            {
              code: "tool_call_limited",
              message: "Too many MCP tool calls are already running for this principal.",
            },
          ],
        },
      },
    });
    expect(limitedEvents).toEqual([
      expect.objectContaining({
        transport: "mcp",
        operation: "search_catalog",
        reason: "Too many MCP tool calls are already running for this principal.",
        limitKind: "read",
        agentProfileUrl: null,
      }),
    ]);
  });

  it("passes MCP tool arguments to UCP handlers", async () => {
    const handler = vi.fn(async ({ arguments: args }) => ({
      ucp: { version: UCP_VERSION, status: "ok" as const },
      observed: args,
    }));
    const app = new Hono().route(
      "/ucp/mcp",
      createUcpMcpRoutes({
        mcpToolHandlers: {
          search_catalog: handler,
        },
      }),
    );

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
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        arguments: { query: "charizard" },
      }),
    );
    await expect(response.json()).resolves.toMatchObject({
      result: {
        structuredContent: {
          observed: { query: "charizard" },
        },
        content: [
          {
            type: "text",
            text: "Search Catalog completed.",
          },
        ],
        _meta: {
          ui: {
            resourceUri: UCP_MCP_PRODUCT_CARDS_RESOURCE_URI,
          },
        },
      },
    });
  });

  it("keeps machine-readable UCP payloads out of MCP content blocks", async () => {
    const app = new Hono().route(
      "/ucp/mcp",
      createUcpMcpRoutes({
        mcpToolHandlers: {
          search_catalog: async () => ({
            ucp: { version: UCP_VERSION, status: "ok" as const },
            products: [
              {
                id: "cat_1",
                title: "Charizard",
              },
            ],
            total: 1,
          }),
        },
      }),
    );

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
    const body = await response.json();
    expect(body.result.structuredContent).toMatchObject({
      products: [{ id: "cat_1", title: "Charizard" }],
      total: 1,
    });
    expect(body.result.content).toEqual([
      {
        type: "text",
        text: "Found 1 marketplace result: Charizard.",
      },
    ]);
    expect(body.result.content).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: "json" })]));
  });

  it.each(["legacy", "modern"])(
    "returns an OAuth challenge in tool results when account-scoped handlers require authentication (%s)",
    async (era) => {
      const app = new Hono().route(
        "/ucp/mcp",
        createUcpMcpRoutes({
          mcpToolHandlers: {
            get_checkout: async () => ({
              ucp: { version: UCP_VERSION, status: "error" as const },
              messages: [
                {
                  severity: "error" as const,
                  code: "authentication_required",
                  message: "UCP checkout requires a linked buyer account.",
                },
              ],
            }),
          },
        }),
      );

      const response = await app.request("/ucp/mcp", {
        method: "POST",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "1",
          method: "tools/call",
          params: {
            name: "get_checkout",
            arguments: { id: "chk_1" },
            ...(era === "modern" ? { _meta: modernMeta } : {}),
          },
        }),
        headers:
          era === "modern" ? modernHeaders("tools/call", "get_checkout") : { "Content-Type": "application/json" },
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        result: {
          structuredContent: {
            ucp: { status: "error" },
            messages: [{ code: "authentication_required" }],
          },
          _meta: {
            "mcp/www_authenticate": 'Bearer realm="Chase Sets", scope="dev.ucp.shopping.checkout:manage"',
          },
        },
      });
    },
  );

  it.each(["legacy", "modern"])(
    "refuses non-grant unsigned complete instead of the retired trusted-handoff shortcut (%s)",
    async (era) => {
      const app = new Hono<{
        Variables: {
          actor: ResolvedActor | null;
          context: EventStoreContext | null;
        };
      }>();
      app.use("/ucp/mcp", async (c, next) => {
        c.set("actor", {
          sessionId: "ses_1",
          tenantId: "tenant_1",
          userId: "usr_1",
          accountId: "acct_1",
          membershipId: "mem_1",
          roleKey: "buyer",
          permissions: ["orders.manage"],
        });
        c.set("context", {
          tenantId: "tenant_1" as never,
          audit: {
            performedByUserId: "usr_1" as never,
            forAccountId: "acct_1" as never,
          },
          trace: {},
        });
        await next();
      });
      app.route(
        "/ucp/mcp",
        createUcpMcpRoutes({
          mcpToolHandlers: {
            complete_checkout: vi.fn(),
          },
        }),
      );

      const response = await app.request("/ucp/mcp", {
        method: "POST",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "1",
          method: "tools/call",
          params: {
            name: "complete_checkout",
            arguments: { id: "chk_1" },
            ...(era === "modern" ? { _meta: modernMeta } : {}),
          },
        }),
        headers:
          era === "modern" ? modernHeaders("tools/call", "complete_checkout") : { "Content-Type": "application/json" },
      });

      // Brief dispatch table replaces the any-OAuth-actor shortcut with a grant requirement.
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        result: {
          structuredContent: {
            ucp: { status: "error" },
            messages: [{ code: "authorization_forbidden" }],
          },
          _meta: {
            ui: {
              resourceUri: UCP_MCP_CHECKOUT_HANDOFF_RESOURCE_URI,
            },
            "openai/outputTemplate": UCP_MCP_CHECKOUT_HANDOFF_RESOURCE_URI,
          },
        },
      });
    },
  );

  it("replays idempotent MCP tool calls with fresh JSON-RPC ids and rejects changed arguments", async () => {
    const handler = vi.fn(async () => ({
      ucp: { version: UCP_VERSION, status: "ok" as const },
      checkout: { id: `chk_${handler.mock.calls.length}` },
    }));
    const app = new Hono().route(
      "/ucp/mcp",
      createUcpMcpRoutes({
        mcpToolHandlers: {
          complete_checkout: handler,
        },
      }),
    );
    const firstBody = JSON.stringify({
      jsonrpc: "2.0",
      id: "1",
      method: "tools/call",
      params: {
        name: "complete_checkout",
        arguments: { id: "chk_1" },
      },
    });
    const replayBody = JSON.stringify({
      jsonrpc: "2.0",
      id: "2",
      method: "tools/call",
      params: {
        name: "complete_checkout",
        arguments: { id: "chk_1" },
      },
    });
    const conflictBody = JSON.stringify({
      jsonrpc: "2.0",
      id: "3",
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
      body: replayBody,
      headers: signedHeaders(replayBody, { "Idempotency-Key": "idem_2" }),
    });
    const conflict = await app.request("/ucp/mcp", {
      method: "POST",
      body: conflictBody,
      headers: signedHeaders(conflictBody, { "Idempotency-Key": "idem_2" }),
    });

    expect(handler).toHaveBeenCalledTimes(1);
    await expect(first.json()).resolves.toMatchObject({
      result: { structuredContent: { checkout: { id: "chk_1" } } },
    });
    await expect(replay.json()).resolves.toMatchObject({
      result: { structuredContent: { checkout: { id: "chk_1" } } },
    });
    expect(conflict.status).toBe(200);
    await expect(conflict.json()).resolves.toMatchObject({
      error: {
        message: "Idempotency-Key was already used with different request parameters.",
      },
    });
  });

  it("returns retry-later for duplicate idempotent MCP tool calls while the first call is still pending", async () => {
    const started = createDeferred();
    const release = createDeferred();
    const handler = vi.fn(async () => {
      started.resolve();
      await release.promise;
      return {
        ucp: { version: UCP_VERSION, status: "ok" as const },
        checkout: { id: "chk_1" },
      };
    });
    const app = new Hono().route(
      "/ucp/mcp",
      createUcpMcpRoutes({
        mcpToolHandlers: {
          complete_checkout: handler,
        },
      }),
    );
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: "1",
      method: "tools/call",
      params: {
        name: "complete_checkout",
        arguments: { id: "chk_1" },
      },
    });
    const headers = signedHeaders(body, { "Idempotency-Key": "idem_mcp_pending" });

    const first = app.request("/ucp/mcp", {
      method: "POST",
      body,
      headers,
    });
    await started.promise;
    const duplicate = await app.request("/ucp/mcp", {
      method: "POST",
      body,
      headers,
    });
    release.resolve();
    const firstResponse = await Promise.resolve(first);

    expect(duplicate.status).toBe(200);
    await expect(duplicate.json()).resolves.toMatchObject({
      error: {
        code: -32029,
        message: "A matching request is already in progress. Retry later.",
      },
    });
    await expect(firstResponse.json()).resolves.toMatchObject({
      result: { structuredContent: { checkout: { id: "chk_1" } } },
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

function createFakeProfileDb() {
  const profiles = new Map<
    string,
    {
      profile: unknown;
      expires_at: string;
    }
  >();

  return {
    async query<Row = Record<string, unknown>>(text: string, values: readonly unknown[] = []) {
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
  const records = new Map<
    string,
    {
      key: string;
      request_hash: string;
      response: unknown | null;
      status: "pending" | "completed";
      created_at: string;
      expires_at: string | null;
    }
  >();

  return {
    async query<Row = Record<string, unknown>>(text: string, values: readonly unknown[] = []) {
      if (text.includes("VALUES ($1, $2, NULL, 'pending'")) {
        const existing = records.get(String(values[0]));
        if (existing) {
          const expired =
            existing.status === "pending" &&
            existing.expires_at !== null &&
            new Date(existing.expires_at).getTime() <= Date.now();
          if (!expired) {
            return { rows: [], rowCount: 0 };
          }
        }
        const row = {
          key: String(values[0]),
          request_hash: String(values[1]),
          response: null,
          status: "pending" as const,
          created_at: String(values[2]),
          expires_at: values[3] ? String(values[3]) : null,
        };
        records.set(row.key, row);
        return { rows: [row as Row], rowCount: 1 };
      }

      if (text.includes("INSERT INTO platform_ucp_idempotency_records")) {
        const row = {
          key: String(values[0]),
          request_hash: String(values[1]),
          response: JSON.parse(String(values[2] ?? "{}")),
          status: "completed" as const,
          created_at: String(values[3]),
          expires_at: values[4] ? String(values[4]) : null,
        };
        records.set(row.key, row);
        return { rows: [], rowCount: 1 };
      }

      if (text.includes("UPDATE platform_ucp_idempotency_records")) {
        const row = records.get(String(values[0]));
        if (row && row.request_hash === values[1] && row.status === "pending") {
          row.response = JSON.parse(String(values[2] ?? "{}"));
          row.status = "completed";
          row.expires_at = values[3] ? String(values[3]) : null;
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }

      if (text.includes("SELECT key, request_hash")) {
        const row = records.get(String(values[0]));
        const live = Boolean(row && (!row.expires_at || new Date(row.expires_at).getTime() > Date.now()));
        return {
          rows: live && row ? [row as Row] : [],
          rowCount: live ? 1 : 0,
        };
      }

      if (text.includes("DELETE FROM platform_ucp_idempotency_records")) {
        if (text.includes("AND request_hash = $2")) {
          const row = records.get(String(values[0]));
          if (row && row.request_hash === values[1] && row.status === "pending") {
            records.delete(row.key);
            return { rows: [], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }
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
