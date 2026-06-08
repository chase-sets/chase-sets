import { CHASE_SETS_READ_TARGET_CONTEXT_HEADER } from "@chase-sets/http/responses";
import { CHASE_SETS_INTERNAL_API_ORIGIN_ENV } from "@chase-sets/platform-runtime/http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCommercialTermsRequestApiClient } from "./api-client";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("createCommercialTermsRequestApiClient", () => {
  it("forwards admin session credentials and read target context to platform-api", async () => {
    vi.stubEnv(CHASE_SETS_INTERNAL_API_ORIGIN_ENV, "https://platform-api.internal");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        items: [],
      }),
    );
    const request = new Request("https://admin.chasesets.com/commerce/terms/schedules", {
      headers: {
        authorization: "Bearer admin-session",
        cookie: "session=admin",
      },
    });

    await createCommercialTermsRequestApiClient(request).listSchedules("limit=1&offset=0");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [input, init] = fetchMock.mock.calls[0];
    expect(input).toBe("https://platform-api.internal/api/commercial-terms/schedules?limit=1&offset=0");
    expect(init?.credentials).toBe("include");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer admin-session");
    expect(headers.get("cookie")).toBe("session=admin");
    expect(headers.get(CHASE_SETS_READ_TARGET_CONTEXT_HEADER)).toBe("commercial-terms");
  });

  it("reports non-json API topology failures with sanitized diagnostics", async () => {
    vi.stubEnv(CHASE_SETS_INTERNAL_API_ORIGIN_ENV, "https://admin-support-api.internal");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("not found", {
        status: 404,
        headers: { "content-type": "text/plain" },
      }),
    );
    const warnMock = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const request = new Request("https://admin.chasesets.com/commerce/terms/schedules", {
      headers: {
        authorization: "Bearer admin-session",
        cookie: "session=admin",
      },
    });

    await expect(
      createCommercialTermsRequestApiClient(request).listSchedules("limit=1&offset=0"),
    ).rejects.toMatchObject({
      status: 404,
      request: {
        method: "GET",
        origin: "https://admin-support-api.internal",
        pathname: "/api/commercial-terms/schedules",
        contentType: "text/plain",
      },
    });
    expect(warnMock).toHaveBeenCalledWith("[commercial-terms-admin-api] request failed", {
      status: 404,
      method: "GET",
      origin: "https://admin-support-api.internal",
      pathname: "/api/commercial-terms/schedules",
      contentType: "text/plain",
    });
  });
});
