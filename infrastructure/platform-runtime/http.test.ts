import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHASE_SETS_INTERNAL_API_ORIGIN_ENV,
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

    expect(resolveRequestApiBaseUrl(request, "/api/auth")).toBe(
      "https://admin.chasesets.test/api/auth",
    );
  });

  it("uses the configured internal API origin for server-side component calls", () => {
    vi.stubEnv(CHASE_SETS_INTERNAL_API_ORIGIN_ENV, "http://admin-support-api:8080");
    const request = new Request("https://admin.chasesets.test/catalog");

    expect(resolveRequestApiBaseUrl(request, "/api/catalog")).toBe(
      "http://admin-support-api:8080/api/catalog",
    );
  });
});
