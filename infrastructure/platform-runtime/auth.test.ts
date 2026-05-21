import { describe, expect, it } from "vitest";
import { AuthResolutionError, isTransientAuthResolutionError, resolveActorFromAuthApi } from "./auth";

describe("platform auth actor resolution", () => {
  it("returns null when the auth api reports unauthenticated", async () => {
    const fetch: typeof globalThis.fetch = async () => new Response(null, { status: 401 });

    await expect(
      resolveActorFromAuthApi({
        request: new Request("http://localhost/account"),
        fetch,
      }),
    ).resolves.toBeNull();
  });

  it("raises typed errors for transient auth gateway failures", async () => {
    const fetch: typeof globalThis.fetch = async () => new Response(null, { status: 502 });

    await expect(
      resolveActorFromAuthApi({
        request: new Request("http://localhost/account"),
        fetch,
      }),
    ).rejects.toMatchObject({
      authApiBaseUrl: "http://localhost/api/auth",
      status: 502,
    });

    expect(isTransientAuthResolutionError(new AuthResolutionError("/api/auth", 502))).toBe(true);
    expect(isTransientAuthResolutionError(new AuthResolutionError("/api/auth", 500))).toBe(false);
  });
});
