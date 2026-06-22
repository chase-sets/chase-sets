import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionFunctionArgs } from "react-router";
import { defineAuthHost } from "./auth-host";

const host = defineAuthHost({
  signInPath: "/sign-in",
  fallbackPath: "/account",
  defaultSuccessPath: "/account",
  accountSelectionPath: "/account/select",
  signedOutReturnTo: "/search",
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("auth host", () => {
  function createTransientAuthFetchError() {
    return Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ECONNREFUSED" },
    });
  }

  function createPasswordSignInRequest() {
    return new Request("https://marketplace.test/sign-in?returnTo=/account/sell-list", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        intent: "password",
        email: "seller@example.test",
        password: "correct-password",
      }),
    });
  }

  function createActionArgs(request: Request): ActionFunctionArgs {
    return {
      request,
      params: {},
      context: {},
      url: new URL(request.url),
      pattern: "/sign-in",
    };
  }

  function createSessionStartedResult() {
    return {
      type: "session-started",
      userId: "usr_1",
      sessionId: "ses_1",
      sessionToken: "session_token",
      session: {
        session_id: "ses_1",
        user_id: "usr_1",
        user_display_name: null,
        user_primary_email: "seller@example.test",
        account_id: "acc_1",
        account_display_name: "Seller",
        account_name: "Seller",
        available_account_ids: ["acc_1"],
        authentication_method: "password",
        status: "active",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        updated_at: new Date().toISOString(),
      },
      memberships: [
        {
          membershipId: "mem_1",
          accountId: "acc_1",
          roleKey: "owner",
          status: "active",
          rolePermissions: ["accounts.view"],
        },
      ],
    };
  }

  it("retries transient internal auth connection failures during password sign-in", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(createTransientAuthFetchError())
      .mockResolvedValueOnce(Response.json(createSessionStartedResult()));
    vi.stubGlobal("fetch", fetch);

    const response = await host.createSignInAction()(createActionArgs(createPasswordSignInRequest()));

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(302);
    expect((response as Response).headers.get("Location")).toBe("/account/sell-list");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps repeated internal auth connection failures on the sign-in form", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(createTransientAuthFetchError());
    vi.stubGlobal("fetch", fetch);

    const result = await host.createSignInAction()(createActionArgs(createPasswordSignInRequest()));

    expect(result).toEqual({
      error: "Sign-in is temporarily unavailable. Try again in a few seconds.",
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("clears and revokes guest checkout state alongside normal session sign-out", async () => {
    const fetchPaths: string[] = [];
    const fetch: typeof globalThis.fetch = vi.fn(async (input) => {
      fetchPaths.push(new URL(String(input)).pathname);
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", fetch);

    const response = await host.signOutActor(
      new Request("https://marketplace.test/sign-out", {
        method: "POST",
        headers: {
          cookie: "chase_sets_guest_checkout=guest_token; chase_sets_session=session_token",
        },
      }),
    );
    const cookies = response.headers.getSetCookie();

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/search");
    expect(cookies.find((cookie) => cookie.startsWith("chase_sets_guest_checkout="))).toContain("Max-Age=0");
    expect(cookies.find((cookie) => cookie.startsWith("chase_sets_guest_checkout="))).toContain("Secure");
    expect(cookies.find((cookie) => cookie.startsWith("chase_sets_session="))).toContain("Max-Age=0");
    expect(fetchPaths).toEqual(["/api/auth/guest-checkout/exit", "/api/auth/sign-out"]);
  });
});
