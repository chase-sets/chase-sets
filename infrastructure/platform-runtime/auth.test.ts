import { describe, expect, it } from "vitest";
import {
  CHASE_SETS_READ_AFTER_WRITE_HEADER,
  CHASE_SETS_READ_TARGET_CONTEXT_HEADER,
  appendFreshWriteToken,
  decodeFreshWriteReceipt,
} from "@chase-sets/http/responses";
import { AuthResolutionError, isTransientAuthResolutionError, resolveActorFromAuthApi } from "./auth";

describe("platform auth actor resolution", () => {
  it("targets Auth freshness when resolving the current actor after a browser auth write", async () => {
    const observedAtMs = Date.now();
    const request = new Request(
      `http://localhost/account${appendFreshWriteToken(
        "",
        {
          commitPositions: [
            {
              sourceContextName: "auth",
              maxGlobalPosition: "12",
              eventIds: ["evt_auth_session"],
            },
            {
              sourceContextName: "identity",
              maxGlobalPosition: "42",
              eventIds: ["evt_identity_account"],
            },
          ],
          commitEventIds: ["evt_auth_session", "evt_identity_account"],
        },
        observedAtMs,
      )}`,
      {
        headers: { cookie: "session=sess_1" },
      },
    );
    let observedHeaders = new Headers();
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      observedHeaders = new Headers(init?.headers);
      return new Response(
        JSON.stringify({
          actor: {
            sessionId: "sess_1",
            tenantId: "tnt_1",
            userId: "usr_1",
            accountId: "acc_1",
            membershipId: "mbr_1",
            roleKey: "owner",
            permissions: ["accounts.view"],
          },
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    };

    await resolveActorFromAuthApi({ request, fetch });

    expect(observedHeaders.get("cookie")).toBe("session=sess_1");
    expect(observedHeaders.get(CHASE_SETS_READ_TARGET_CONTEXT_HEADER)).toBe("auth");
    expect(decodeFreshWriteReceipt(observedHeaders.get(CHASE_SETS_READ_AFTER_WRITE_HEADER), observedAtMs)).toEqual({
      observedAtMs,
      sources: [
        {
          sourceContextName: "auth",
          maxGlobalPosition: "12",
          eventIds: ["evt_auth_session"],
        },
        {
          sourceContextName: "identity",
          maxGlobalPosition: "42",
          eventIds: ["evt_identity_account"],
        },
      ],
    });
  });

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

  it("reports invalid auth API base URLs with an actionable option name", async () => {
    await expect(
      resolveActorFromAuthApi({
        request: new Request("http://localhost/account"),
        authApiBaseUrl: "not a url",
      }),
    ).rejects.toThrow("authApiBaseUrl must be a valid absolute URL.");
  });

  it("treats rejected auth fetches as transient auth resolution failures", async () => {
    const cause = new TypeError("fetch failed");
    const fetch: typeof globalThis.fetch = async () => {
      throw cause;
    };

    await expect(
      resolveActorFromAuthApi({
        request: new Request("http://localhost/account"),
        fetch,
      }),
    ).rejects.toMatchObject({
      authApiBaseUrl: "http://localhost/api/auth",
      status: 503,
      cause,
    });

    try {
      await resolveActorFromAuthApi({
        request: new Request("http://localhost/account"),
        fetch,
      });
    } catch (error) {
      expect(isTransientAuthResolutionError(error)).toBe(true);
    }
  });
});
