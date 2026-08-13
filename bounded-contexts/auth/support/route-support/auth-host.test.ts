import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActionFunctionArgs } from "react-router";
import {
  CHASE_SETS_COMMIT_RECEIPT_HEADER,
  CHASE_SETS_READ_AFTER_WRITE_HEADER,
  appendFreshWriteToken,
  encodeCommitReceipt,
  readFreshWriteToken,
  type SourceCommitPosition,
} from "@chase-sets/http/responses";
import { CHASE_SETS_INTERNAL_API_ORIGIN_ENV } from "@chase-sets/platform-runtime/http";
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
  vi.unstubAllEnvs();
});

describe("auth host", () => {
  const identitySource = {
    sourceContextName: "identity",
    maxGlobalPosition: "51",
    eventIds: ["evt_identity_51"],
  } as const satisfies SourceCommitPosition;
  const authSource = {
    sourceContextName: "auth",
    maxGlobalPosition: "71",
    eventIds: ["evt_auth_71"],
  } as const satisfies SourceCommitPosition;

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

  function createMagicLinkRequest(returnTo = "/account/sell-list") {
    return new Request(`https://marketplace.test/sign-in?returnTo=${encodeURIComponent(returnTo)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        intent: "magic-link-request",
        email: "seller@example.test",
      }),
    });
  }

  function createPasswordRegistrationRequest(returnTo = "") {
    return new Request(`https://marketplace.test/register${returnTo}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        intent: "password",
        displayName: "New Seller",
        email: "seller@example.test",
        password: "correct-password",
      }),
    });
  }

  function createPasskeyRegistrationRequest() {
    return new Request("https://marketplace.test/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        intent: "passkey-register",
        displayName: "New Seller",
        email: "seller@example.test",
        challengeId: "cmd_challenge",
        challenge: "challenge",
        externalCredentialId: "external_credential",
        label: "Passkey",
        webauthnResponse: "webauthn_response",
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

  function authJsonResponse(body: object, sources: readonly SourceCommitPosition[]) {
    return new Response(JSON.stringify(body), {
      headers: {
        "Content-Type": "application/json",
        "Chase-Sets-Consistency": "eventual",
        [CHASE_SETS_COMMIT_RECEIPT_HEADER]: encodeCommitReceipt(sources),
      },
    });
  }

  function registrationFetchStub(sources: readonly SourceCommitPosition[]) {
    const registrationCalls: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      registrationCalls.push(new URL(url).pathname);
      if (url.endsWith("/registration-consent")) {
        return Response.json({
          bundleKey: "registration",
          requirements: [],
          resolvedAt: "2026-07-25T00:00:00.000Z",
          signature: "server-minted-test-signature",
        });
      }
      return authJsonResponse(createSessionStartedResult(), sources);
    });
    return { fetch, registrationCalls };
  }

  function redirectLocation(response: unknown) {
    expect(response).toBeInstanceOf(Response);
    const location = (response as Response).headers.get("Location");
    expect(location).toBeTruthy();
    return new URL(location!, "https://marketplace.test");
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

  it("retries actor resolution without fresh-write metadata after transient auth freshness failures", async () => {
    vi.stubEnv(CHASE_SETS_INTERNAL_API_ORIGIN_ENV, "https://admin.test");
    const observedHeaders: Headers[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      observedHeaders.push(new Headers(init?.headers));
      if (observedHeaders.length === 1) {
        return Response.json({ error: "Projection freshness timed out." }, { status: 503 });
      }

      return Response.json({ actor: createSessionStartedResult().session });
    });
    vi.stubGlobal("fetch", fetch);

    const request = new Request(
      `https://admin.test${appendFreshWriteToken("/access/invitations/ivt_1", { commandReceipt: { commitPositions: [identitySource] } })}`,
      { headers: { cookie: "chase_sets_session=session_token" } },
    );

    await expect(host.resolveActor(request)).resolves.toMatchObject({ session_id: "ses_1" });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(observedHeaders[0]!.get(CHASE_SETS_READ_AFTER_WRITE_HEADER)).toBeTruthy();
    expect(observedHeaders[1]!.get(CHASE_SETS_READ_AFTER_WRITE_HEADER)).toBeNull();
  });

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
    expect((response as Response).headers.get("X-Remix-Reload-Document")).toBe("true");
    expect((response as Response).headers.getSetCookie().join(";")).toContain("chase_sets_session=session_token");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("returns the attempted identifier and method after a password sign-in error", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(Response.json({ error: "Invalid email or password." }, { status: 401 })),
    );

    const result = await host.createSignInAction()(createActionArgs(createPasswordSignInRequest()));

    expect(result).toEqual({
      error: "Invalid email or password.",
      identifier: "seller@example.test",
      method: "password",
    });
  });

  it("requests magic links with the host landing path and safe return path", async () => {
    let requestBody: unknown;
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return Response.json({
        tokenId: "cmd_magic",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
    });
    vi.stubGlobal("fetch", fetch);

    const result = await host.createSignInAction()(createActionArgs(createMagicLinkRequest()));

    expect(result).toMatchObject({
      status: "magic-link-sent",
      tokenId: "cmd_magic",
      email: "seller@example.test",
    });
    expect(requestBody).toEqual({
      email: "seller@example.test",
      landingPath: "/sign-in/magic",
      returnTo: "/account/sell-list",
    });
  });

  it("uses the host success path when a magic-link request return path is unsafe", async () => {
    let requestBody: unknown;
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return Response.json({
        tokenId: "cmd_magic",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
    });
    vi.stubGlobal("fetch", fetch);

    await host.createSignInAction()(createActionArgs(createMagicLinkRequest("//evil.test")));

    expect(requestBody).toEqual({
      email: "seller@example.test",
      landingPath: "/sign-in/magic",
      returnTo: "/account",
    });
  });

  it("keeps repeated internal auth connection failures on the sign-in form", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(createTransientAuthFetchError());
    vi.stubGlobal("fetch", fetch);

    const result = await host.createSignInAction()(createActionArgs(createPasswordSignInRequest()));

    expect(result).toEqual({
      error: "Sign-in is temporarily unavailable. Try again in a few seconds.",
      identifier: "seller@example.test",
      method: "password",
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("adds the identity fresh-write receipt to password registration account redirects", async () => {
    const { fetch, registrationCalls } = registrationFetchStub([identitySource]);
    vi.stubGlobal("fetch", fetch);

    const response = await host.createRegisterAction()(createActionArgs(createPasswordRegistrationRequest()));
    const location = redirectLocation(response);

    // The route action resolves before it registers.
    expect(registrationCalls).toEqual(["/api/auth/registration-consent", "/api/auth/register"]);
    expect((response as Response).headers.get("X-Remix-Reload-Document")).toBe("true");
    expect((response as Response).headers.getSetCookie().join(";")).toContain("chase_sets_session=session_token");
    expect(location.pathname).toBe("/account");
    expect(location.searchParams.get("authPrompt")).toBe("add-passkey");
    expect(readFreshWriteToken(location)).toMatchObject({
      sources: [identitySource],
    });
  });

  it("posts the exact fetched resolution as the register request's registration consent", async () => {
    // Resolving before registering is not enough on its own: the value the
    // marketplace register action POSTs has to be the value it fetched, byte
    // for byte. A route that resolved and then assembled its own submission
    // would still make the call sequence above look right.
    const registrationBodies: unknown[] = [];
    const mintedResolution = {
      bundleKey: "registration",
      requirements: [],
      resolvedAt: "2026-07-25T00:00:00.000Z",
      signature: "server-minted-test-signature",
    };
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/registration-consent")) {
        return Response.json(mintedResolution);
      }
      registrationBodies.push(JSON.parse(String(init?.body ?? "{}")));
      return authJsonResponse(createSessionStartedResult(), [identitySource]);
    });
    vi.stubGlobal("fetch", fetch);

    await host.createRegisterAction()(createActionArgs(createPasswordRegistrationRequest()));

    expect(registrationBodies).toHaveLength(1);
    expect(registrationBodies[0]).toMatchObject({
      registrationConsent: { resolution: mintedResolution, affirmed: false },
    });
  });

  it("adds the identity fresh-write receipt to passkey registration account redirects without prompting for another passkey", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      authJsonResponse(
        {
          credentialId: "crd_1",
          userId: "usr_1",
          authResult: createSessionStartedResult(),
        },
        [identitySource],
      ),
    );
    vi.stubGlobal("fetch", fetch);

    const response = await host.createRegisterAction()(createActionArgs(createPasskeyRegistrationRequest()));
    const location = redirectLocation(response);

    expect((response as Response).headers.get("X-Remix-Reload-Document")).toBe("true");
    expect((response as Response).headers.getSetCookie().join(";")).toContain("chase_sets_session=session_token");
    expect(location.pathname).toBe("/account");
    expect(location.searchParams.get("authPrompt")).toBeNull();
    expect(readFreshWriteToken(location)).toMatchObject({
      sources: [identitySource],
    });
  });

  it("carries identity freshness through account-selection cookie continuations", () => {
    const response = host.completeAuthentication(
      new Request("https://marketplace.test/register", {
        method: "POST",
      }),
      {
        type: "account-selection-required",
        userId: "usr_1",
        selectionToken: "selection_token",
        selectionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        memberships: [
          {
            membershipId: "mem_1",
            accountId: "acc_1",
            roleKey: "owner",
            status: "active",
            rolePermissions: ["accounts.view"],
          },
        ],
      },
      {
        freshWriteSource: {
          commitPositions: [identitySource],
          commitEventIds: ["evt_identity_51"],
        },
      },
    );
    const location = redirectLocation(response);
    const returnTo = location.searchParams.get("returnTo");

    expect(response.headers.get("X-Remix-Reload-Document")).toBe("true");
    expect(response.headers.getSetCookie().join(";")).toContain("chase_sets_account_selection=selection_token");
    expect(location.pathname).toBe("/account/select");
    expect(readFreshWriteToken(String(returnTo))).toMatchObject({
      sources: [identitySource],
    });
  });

  it("does not use Auth-only receipts as account freshness evidence during registration redirects", async () => {
    const { fetch } = registrationFetchStub([authSource]);
    vi.stubGlobal("fetch", fetch);

    const response = await host.createRegisterAction()(createActionArgs(createPasswordRegistrationRequest()));
    const location = redirectLocation(response);

    expect((response as Response).headers.get("X-Remix-Reload-Document")).toBe("true");
    expect(location.pathname).toBe("/account");
    expect(location.searchParams.get("authPrompt")).toBe("add-passkey");
    expect(location.searchParams.get("afterWrite")).toBeNull();
  });

  it("does not attach identity freshness to marketplace registration continuations", async () => {
    const { fetch } = registrationFetchStub([identitySource]);
    vi.stubGlobal("fetch", fetch);

    const response = await host.createRegisterAction()(
      createActionArgs(
        createPasswordRegistrationRequest(
          `?returnTo=${encodeURIComponent("/account/listings?claimListingIntent=ldi_1")}`,
        ),
      ),
    );
    const location = redirectLocation(response);

    expect((response as Response).headers.get("X-Remix-Reload-Document")).toBe("true");
    expect(location.pathname).toBe("/account/listings");
    expect(location.searchParams.get("claimListingIntent")).toBe("ldi_1");
    expect(location.searchParams.get("afterWrite")).toBeNull();
  });

  it("clears and revokes guest checkout state alongside normal session sign-out", async () => {
    vi.stubEnv(CHASE_SETS_INTERNAL_API_ORIGIN_ENV, "https://marketplace.test");
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
    expect(response.headers.get("X-Remix-Reload-Document")).toBe("true");
    expect(cookies.find((cookie) => cookie.startsWith("chase_sets_guest_checkout="))).toContain("Max-Age=0");
    expect(cookies.find((cookie) => cookie.startsWith("chase_sets_guest_checkout="))).toContain("Secure");
    expect(cookies.find((cookie) => cookie.startsWith("chase_sets_session="))).toContain("Max-Age=0");
    expect(fetchPaths).toEqual(["/api/auth/guest-checkout/exit", "/api/auth/sign-out"]);
  });
});
