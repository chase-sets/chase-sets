import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHASE_SETS_READ_AFTER_WRITE_HEADER,
  CHASE_SETS_READ_TARGET_CONTEXT_HEADER,
  appendFreshWriteToken,
  decodeFreshWriteReceipt,
  encodeFreshWriteReceipt,
} from "@chase-sets/http/responses";
import {
  CHASE_SETS_INTERNAL_API_ORIGIN_ENV,
  createForwardedAuthFetch,
  createForwardedAuthHeaders,
  resolveInternalApiOrigin,
  resolveRequestApiBaseUrl,
} from "./http";

afterEach(() => {
  vi.unstubAllEnvs();
});

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
