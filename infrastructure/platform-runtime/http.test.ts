import { afterEach, describe, expect, it, vi } from "vitest";
import { CHASE_SETS_INTERNAL_API_ORIGIN_ENV, resolveInternalApiOrigin, resolveRequestApiBaseUrl } from "./http";

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
