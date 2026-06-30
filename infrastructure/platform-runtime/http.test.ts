import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHASE_SETS_READ_AFTER_WRITE_HEADER,
  CHASE_SETS_READ_TARGET_CONTEXT_HEADER,
  COOKIE_BACKED_CONTINUATION_RELOAD_HEADER,
  appendCompactPostWriteToken,
  appendFreshWriteToken,
  decodeFreshWriteReceipt,
  encodeFreshWriteReceipt,
  readCompactPostWriteToken,
  type PostWriteTokenPayload,
} from "@chase-sets/http/responses";
import {
  CHASE_SETS_INTERNAL_API_ORIGIN_ENV,
  createForwardedAuthHeadersAsync,
  createForwardedAuthFetch,
  createForwardedAuthHeaders,
  loadAfterWrite,
  navigateAfterWrite,
  navigateAfterWriteWithCompactToken,
  readOffsetPageParams,
  redirectAfterWrite,
  redirectAfterWriteWithCompactToken,
  resolveInternalApiOrigin,
  resolvePostWriteTokenRequest,
  resolveRequestApiBaseUrl,
  UnresolvedPostWriteTokenError,
} from "./http";
import { registerPostWriteConsistencyRecorder } from "./post-write-consistency";

let unregisterPostWriteTelemetry: (() => void) | null = null;

afterEach(() => {
  unregisterPostWriteTelemetry?.();
  unregisterPostWriteTelemetry = null;
  vi.unstubAllEnvs();
});

function createTestPostWriteTokenStore() {
  const payloads = new Map<string, PostWriteTokenPayload>();
  const storeCalls: Array<Readonly<{ payload: PostWriteTokenPayload; nowMs: number; ttlMs: number }>> = [];
  let nextToken = 1;

  return {
    storeCalls,
    async storePostWriteToken(payload: PostWriteTokenPayload, options: Readonly<{ nowMs: number; ttlMs: number }>) {
      const token = `pwt_${String(nextToken++).padStart(20, "0")}`;
      payloads.set(token, payload);
      storeCalls.push({ payload, ...options });
      return token;
    },
    async resolvePostWriteToken(token: string) {
      return payloads.get(token) ?? null;
    },
  };
}

describe("resolveInternalApiOrigin", () => {
  it("returns null when no internal API origin is configured", () => {
    expect(resolveInternalApiOrigin({})).toBeNull();
  });

  it("normalizes the configured internal API origin", () => {
    expect(
      resolveInternalApiOrigin({
        [CHASE_SETS_INTERNAL_API_ORIGIN_ENV]: "http://api.internal:8080/",
      }),
    ).toBe("http://api.internal:8080");
  });
});

describe("resolveRequestApiBaseUrl", () => {
  it("defaults to the request origin for same-origin browser routing", () => {
    const request = new Request("https://admin.chasesets.test/catalog");

    expect(resolveRequestApiBaseUrl(request, "/api/auth")).toBe("https://admin.chasesets.test/api/auth");
  });

  it("uses forwarded HTTPS origin when a platform proxy terminates TLS", () => {
    const request = new Request("http://internal-app/api/auth/social/google/callback", {
      headers: {
        "x-forwarded-host": "admin.chasesets.com",
        "x-forwarded-proto": "https",
      },
    });

    expect(resolveRequestApiBaseUrl(request, "/api/identity/internal/auth")).toBe(
      "https://admin.chasesets.com/api/identity/internal/auth",
    );
  });

  it("keeps local HTTP origins for local development", () => {
    const request = new Request("http://localhost:6712/api/auth/social/google/callback");

    expect(resolveRequestApiBaseUrl(request, "/api/identity/internal/auth")).toBe(
      "http://localhost:6712/api/identity/internal/auth",
    );
  });

  it("uses the configured internal API origin for server-side component calls", () => {
    vi.stubEnv(CHASE_SETS_INTERNAL_API_ORIGIN_ENV, "http://admin-support-api:8080");
    const request = new Request("https://admin.chasesets.test/catalog");

    expect(resolveRequestApiBaseUrl(request, "/api/catalog")).toBe("http://admin-support-api:8080/api/catalog");
  });
});

describe("readOffsetPageParams", () => {
  it("normalizes offset pagination from route URLs", () => {
    expect(readOffsetPageParams("https://admin.chasesets.test/access/users?limit=25&offset=75")).toEqual({
      limit: 25,
      offset: 75,
      query: "limit=25&offset=75",
    });
  });

  it("clamps unsafe or malformed pagination to bounded defaults", () => {
    expect(
      readOffsetPageParams("https://admin.chasesets.test/access/users?limit=999999&offset=-1%20UNION%20SELECT", {
        defaultLimit: 50,
        maxLimit: 500,
      }),
    ).toEqual({
      limit: 500,
      offset: 0,
      query: "limit=500&offset=0",
    });
  });
});

describe("createForwardedAuthHeaders", () => {
  it("forwards auth and read-after-write headers for route API clients", () => {
    const observedAtMs = Date.now();
    const href = appendFreshWriteToken(
      "/account/listings/lst_1",
      {
        commitPositions: [
          {
            sourceContextName: "marketplace",
            maxGlobalPosition: "42",
            eventIds: ["evt_1"],
          },
        ],
        commitEventIds: ["evt_1"],
      },
      observedAtMs,
    );
    const request = new Request(`https://marketplace.chasesets.test${href}`, {
      headers: {
        authorization: "Bearer account-token",
        cookie: "session=sess_1",
      },
    });

    const headers = createForwardedAuthHeaders(request, undefined, { readTargetContextName: "marketplace" });

    expect(headers.get("authorization")).toBe("Bearer account-token");
    expect(headers.get("cookie")).toBe("session=sess_1");
    expect(headers.get(CHASE_SETS_READ_TARGET_CONTEXT_HEADER)).toBe("marketplace");
    expect(decodeFreshWriteReceipt(headers.get(CHASE_SETS_READ_AFTER_WRITE_HEADER), observedAtMs)).toEqual({
      observedAtMs,
      sources: [
        {
          sourceContextName: "marketplace",
          maxGlobalPosition: "42",
          eventIds: ["evt_1"],
        },
      ],
    });
  });

  it("preserves caller-provided freshness headers", () => {
    const request = new Request("https://marketplace.chasesets.test/account/listings/lst_1", {
      headers: {
        authorization: "Bearer account-token",
        cookie: "session=sess_1",
      },
    });
    const explicitReceipt = encodeFreshWriteReceipt({
      observedAtMs: Date.now(),
      sources: [
        {
          sourceContextName: "checkout",
          maxGlobalPosition: "9",
          eventIds: ["evt_checkout"],
        },
      ],
    });

    const headers = createForwardedAuthHeaders(
      request,
      {
        [CHASE_SETS_READ_AFTER_WRITE_HEADER]: explicitReceipt,
        [CHASE_SETS_READ_TARGET_CONTEXT_HEADER]: "checkout",
      },
      { readTargetContextName: "marketplace" },
    );

    expect(headers.get(CHASE_SETS_READ_AFTER_WRITE_HEADER)).toBe(explicitReceipt);
    expect(headers.get(CHASE_SETS_READ_TARGET_CONTEXT_HEADER)).toBe("checkout");
  });

  it("resolves compact post-write tokens before forwarding freshness headers", async () => {
    const store = createTestPostWriteTokenStore();
    const observedAtMs = Date.now();
    const href = await navigateAfterWriteWithCompactToken(
      {
        commitPositions: [
          {
            sourceContextName: "checkout",
            maxGlobalPosition: "9",
            eventIds: ["evt_checkout"],
          },
        ],
        commitEventIds: ["evt_checkout"],
      },
      "/account/cart",
      { nowMs: observedAtMs, postWriteTokenStore: store },
    );
    const request = new Request(`https://marketplace.chasesets.test${href}`, {
      headers: {
        cookie: "guest=guest_1",
      },
    });

    const headers = await createForwardedAuthHeadersAsync(request, undefined, {
      postWriteTokenResolver: store,
      readTargetContextName: "checkout",
      nowMs: observedAtMs,
    });

    expect(href).toContain("postWriteToken=");
    expect(href).not.toContain("afterWrite=");
    expect(headers.get("cookie")).toBe("guest=guest_1");
    expect(decodeFreshWriteReceipt(headers.get(CHASE_SETS_READ_AFTER_WRITE_HEADER), observedAtMs)).toEqual({
      observedAtMs,
      sources: [
        {
          sourceContextName: "checkout",
          maxGlobalPosition: "9",
          eventIds: ["evt_checkout"],
        },
      ],
    });
    expect(headers.get(CHASE_SETS_READ_TARGET_CONTEXT_HEADER)).toBe("checkout");
  });
});

describe("createForwardedAuthFetch", () => {
  it("adds include credentials and freshness-aware forwarded headers", async () => {
    const request = new Request(
      `https://marketplace.chasesets.test${appendFreshWriteToken(
        "/checkout/chk_1",
        {
          commitPositions: [
            {
              sourceContextName: "checkout",
              maxGlobalPosition: "9",
              eventIds: ["evt_checkout"],
            },
          ],
          commitEventIds: ["evt_checkout"],
        },
        Date.now(),
      )}`,
      {
        headers: {
          cookie: "guest=guest_1",
        },
      },
    );
    let receivedInit: RequestInit | undefined;
    const fetchImpl: typeof globalThis.fetch = async (_input, init) => {
      receivedInit = init;
      return new Response("{}");
    };

    await createForwardedAuthFetch(request, fetchImpl, { readTargetContextName: "checkout" })(
      "https://api.chasesets.test/api/marketplace/checkout-sessions/chk_1",
    );

    expect(receivedInit?.credentials).toBe("include");
    const headers = new Headers(receivedInit?.headers);
    expect(headers.get("cookie")).toBe("guest=guest_1");
    expect(decodeFreshWriteReceipt(headers.get(CHASE_SETS_READ_AFTER_WRITE_HEADER))).toMatchObject({
      sources: [
        {
          sourceContextName: "checkout",
          maxGlobalPosition: "9",
          eventIds: ["evt_checkout"],
        },
      ],
    });
    expect(headers.get(CHASE_SETS_READ_TARGET_CONTEXT_HEADER)).toBe("checkout");
  });
});

describe("default-safe post-write navigation runtime", () => {
  it("records source-side navigation diagnostics when it encodes a fresh-write receipt", () => {
    const recorder = vi.fn();
    unregisterPostWriteTelemetry = registerPostWriteConsistencyRecorder(recorder);

    const href = navigateAfterWrite(
      {
        commitPositions: [
          {
            sourceContextName: "marketplace",
            maxGlobalPosition: "42",
            eventIds: ["evt_1"],
          },
        ],
        commitEventIds: ["evt_1"],
      },
      "/account/listings/lst_1",
      {
        nowMs: 1234,
        telemetry: {
          boundedContextName: "marketplace",
          surface: "account-listing",
          routeId: "account-listing",
          routeTemplate: "/account/listings/:listingId",
        },
      },
    );

    expect(href).toContain("afterWrite=");
    expect(recorder).toHaveBeenCalledWith(
      expect.objectContaining({
        boundedContextName: "marketplace",
        surface: "account-listing",
        strategy: "fresh-read",
        outcome: "navigation_encoded",
        routeId: "account-listing",
        routeTemplate: "/account/listings/:listingId",
      }),
    );
  });

  it("stores compact post-write token payloads for source-side navigation without URL receipt details", async () => {
    const recorder = vi.fn();
    const store = createTestPostWriteTokenStore();
    unregisterPostWriteTelemetry = registerPostWriteConsistencyRecorder(recorder);

    const href = await navigateAfterWriteWithCompactToken(
      {
        commitPositions: [
          {
            sourceContextName: "marketplace",
            maxGlobalPosition: "42",
            eventIds: ["evt_1"],
          },
        ],
        commitEventIds: ["evt_1"],
        email: "seller@example.com",
      },
      "/account/listings/lst_1?feedbackWorkflow=listing-publish",
      {
        nowMs: 1234,
        postWriteTokenStore: store,
        telemetry: {
          boundedContextName: "marketplace",
          surface: "account-listing",
          routeId: "account-listing",
          routeTemplate: "/account/listings/:listingId",
        },
      },
    );

    expect(readCompactPostWriteToken(href)).toMatch(/^pwt_/);
    expect(href).not.toContain("afterWrite=");
    expect(href).not.toContain("postWriteHandoff=");
    expect(href).not.toContain("evt_1");
    expect(href).not.toContain("seller%40example.com");
    expect(store.storeCalls).toEqual([
      {
        nowMs: 1234,
        ttlMs: 120_000,
        payload: {
          receipt: {
            observedAtMs: 1234,
            sources: [
              {
                sourceContextName: "marketplace",
                maxGlobalPosition: "42",
                eventIds: ["evt_1"],
              },
            ],
          },
        },
      },
    ]);
    expect(recorder).toHaveBeenCalledWith(
      expect.objectContaining({
        boundedContextName: "marketplace",
        surface: "account-listing",
        strategy: "fresh-read",
        outcome: "navigation_encoded",
      }),
    );
  });

  it("creates telemetry-aware cookie-backed continuation redirects", () => {
    const recorder = vi.fn();
    unregisterPostWriteTelemetry = registerPostWriteConsistencyRecorder(recorder);

    const response = redirectAfterWrite(
      {
        commitPositions: [
          {
            sourceContextName: "identity",
            maxGlobalPosition: "51",
            eventIds: ["evt_identity_51"],
          },
        ],
        commitEventIds: ["evt_identity_51"],
      },
      "/account",
      {
        continuation: "cookie-backed",
        headers: {
          "Set-Cookie": "chase_sets_session=session_token; Path=/; HttpOnly; SameSite=Lax",
        },
        nowMs: 1234,
        telemetry: {
          boundedContextName: "auth",
          surface: "registration",
          routeId: "register",
          routeTemplate: "/register",
        },
      },
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toContain("/account?afterWrite=");
    expect(response.headers.get(COOKIE_BACKED_CONTINUATION_RELOAD_HEADER)).toBe("true");
    expect(response.headers.get("Set-Cookie")).toContain("chase_sets_session=session_token");
    expect(recorder).toHaveBeenCalledWith(
      expect.objectContaining({
        boundedContextName: "auth",
        surface: "registration",
        strategy: "fresh-read",
        outcome: "navigation_encoded",
        routeId: "register",
        routeTemplate: "/register",
      }),
    );
  });

  it("creates compact-token redirects with cookie-backed continuation headers", async () => {
    const store = createTestPostWriteTokenStore();

    const response = await redirectAfterWriteWithCompactToken(
      {
        commitPositions: [
          {
            sourceContextName: "identity",
            maxGlobalPosition: "51",
            eventIds: ["evt_identity_51"],
          },
        ],
        commitEventIds: ["evt_identity_51"],
      },
      "/account",
      {
        continuation: "cookie-backed",
        headers: {
          "Set-Cookie": "chase_sets_session=session_token; Path=/; HttpOnly; SameSite=Lax",
        },
        nowMs: 1234,
        postWriteTokenStore: store,
      },
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toContain("/account?postWriteToken=");
    expect(response.headers.get("Location")).not.toContain("afterWrite=");
    expect(response.headers.get(COOKIE_BACKED_CONTINUATION_RELOAD_HEADER)).toBe("true");
    expect(response.headers.get("Set-Cookie")).toContain("chase_sets_session=session_token");
  });

  it("records destination-side read diagnostics for default-safe reads", async () => {
    const recorder = vi.fn();
    unregisterPostWriteTelemetry = registerPostWriteConsistencyRecorder(recorder);
    const href = navigateAfterWrite(
      {
        commitPositions: [
          {
            sourceContextName: "marketplace",
            maxGlobalPosition: "42",
            eventIds: ["evt_1"],
          },
        ],
        commitEventIds: ["evt_1"],
      },
      "/account/listings/lst_1",
      { nowMs: 1234 },
    );

    const result = await loadAfterWrite({
      request: new Request(`https://marketplace.chasesets.test${href}`),
      load: async () => ({ listingId: "lst_1" }),
      isNotFound: () => false,
      nowMs: () => 1234,
      telemetry: {
        boundedContextName: "marketplace",
        surface: "account-listing",
        routeId: "account-listing",
        routeTemplate: "/account/listings/:listingId",
      },
    });

    expect(result).toMatchObject({
      kind: "data",
      data: { listingId: "lst_1" },
    });
    expect(recorder).toHaveBeenCalledWith(
      expect.objectContaining({
        boundedContextName: "marketplace",
        surface: "account-listing",
        strategy: "fresh-read",
        outcome: "read_data",
        recoveryAction: "none",
        freshnessOutcome: "fresh",
      }),
    );
  });

  it("resolves compact tokens before destination reads and semantic handoff evaluation", async () => {
    const store = createTestPostWriteTokenStore();
    const waitForFreshness = vi.fn();
    const href = await navigateAfterWriteWithCompactToken(
      {
        commitPositions: [
          {
            sourceContextName: "checkout",
            maxGlobalPosition: "9",
            eventIds: ["evt_checkout"],
          },
        ],
        commitEventIds: ["evt_checkout"],
      },
      "/account/cart",
      {
        nowMs: 1234,
        postWriteTokenStore: store,
        handoff: {
          kind: "checkout.cart.add-line",
          expectation: "collection-non-empty",
          surface: "account-cart",
        },
      },
    );

    const result = await loadAfterWrite({
      request: new Request(`https://marketplace.chasesets.test${href}`),
      load: async () => ({ items: [], count: 0 }),
      isNotFound: () => false,
      isHandoffSatisfied: (cart, handoff) => handoff.expectation === "collection-non-empty" && cart.items.length > 0,
      waitForFreshness,
      nowMs: () => 1234,
      postWriteTokenResolver: store,
    });

    expect(waitForFreshness).toHaveBeenCalledWith({
      observedAtMs: 1234,
      sources: [
        {
          sourceContextName: "checkout",
          maxGlobalPosition: "9",
          eventIds: ["evt_checkout"],
        },
      ],
    });
    expect(result).toMatchObject({
      kind: "pending",
      reason: "semantic-handoff-pending",
      recoveryKind: "pending-projection",
      handoff: {
        handoff: {
          kind: "checkout.cart.add-line",
          expectation: "collection-non-empty",
          surface: "account-cart",
        },
      },
    });
  });

  it("does not silently degrade unresolved compact tokens to ordinary reads", async () => {
    const store = createTestPostWriteTokenStore();
    const request = new Request(
      `https://marketplace.chasesets.test${appendCompactPostWriteToken("/account/cart", "pwt_missing000000000000")}`,
    );
    const load = vi.fn(async () => ({ items: [{ listingId: "lst_1" }], count: 1 }));

    await expect(resolvePostWriteTokenRequest(request, store)).rejects.toBeInstanceOf(UnresolvedPostWriteTokenError);
    await expect(
      loadAfterWrite({
        request,
        load,
        isNotFound: () => false,
        nowMs: () => 1234,
        postWriteTokenResolver: store,
      }),
    ).resolves.toMatchObject({
      kind: "permanent-failure",
      reason: "fresh-write-read-permanent",
      recoveryKind: "terminal-failure",
      classification: {
        kind: "not-fresh-write",
        transient: false,
        errorCode: "post_write_token_unresolved",
      },
    });
    expect(load).not.toHaveBeenCalled();
  });

  it("preserves legacy full-token destination reads while compact resolution is available", async () => {
    const store = createTestPostWriteTokenStore();
    const href = navigateAfterWrite(
      {
        commitPositions: [
          {
            sourceContextName: "marketplace",
            maxGlobalPosition: "42",
            eventIds: ["evt_1"],
          },
        ],
        commitEventIds: ["evt_1"],
      },
      "/account/listings/lst_1",
      { nowMs: 1234 },
    );
    const request = new Request(`https://marketplace.chasesets.test${href}`);

    await expect(resolvePostWriteTokenRequest(request, store)).resolves.toBe(request);
    await expect(
      loadAfterWrite({
        request,
        load: async () => ({ listingId: "lst_1" }),
        isNotFound: () => false,
        nowMs: () => 1234,
        postWriteTokenResolver: store,
      }),
    ).resolves.toMatchObject({
      kind: "data",
      data: { listingId: "lst_1" },
    });
  });
});
