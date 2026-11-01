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
  it.each([
    "registration_consent_not_server_minted",
    "registration_consent_expired",
    "registration_consent_affirmation_required",
  ])("maps recognized %s consent rejections to the localized form contract", async (code) => {
    const sourceMessage = "secret Identity source message";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json(
          {
            error: {
              code,
              reason: code === "registration_consent_expired" ? "superseded" : "absent",
              message: sourceMessage,
            },
          },
          { status: 400 },
        ),
      ),
    );

    const result = await host.createSignInAction()(createActionArgs(createPasswordSignInRequest()));

    expect(result).toMatchObject({
      error: "Account creation is unavailable right now. Try again in a moment.",
      classification: "FORM",
      intent: "password",
      errors: {
        fieldErrors: {},
        formErrors: ["Account creation is unavailable right now. Try again in a moment."],
      },
    });
    expect(JSON.stringify(result)).not.toContain(sourceMessage);
  });

  it("partitions real routed failures", async () => {
    const detail = { field: "phone", code: "phone_required", message: "Bearer synthetic-secret" };
    const cases = [
      {
        status: 400,
        body: { error: { code: "validation_failed", message: "secret", details: [detail] } },
        intent: "phone-code-request",
        classification: "FIELD",
      },
      ...[
        undefined,
        [],
        [{ ...detail, field: "password" }],
        [{ ...detail, code: "unknown" }],
        [{ ...detail, nested: { token: "secret" } }],
        [{ ...detail, message: "x".repeat(1025) }],
        [detail, detail],
        { phone: detail },
      ].map((details) => ({
        status: 400,
        body: { error: { code: "validation_failed", message: "secret", details } },
        intent: "phone-code-request",
        classification: "INDETERMINATE",
      })),
      { status: 401, body: { error: "secret" }, intent: "password", classification: "FORM" },
      {
        status: 400,
        body: { error: { code: "validation_failed", details: [detail] } },
        intent: "password",
        classification: "INDETERMINATE",
      },
      ...["password", "magic-link-request"].map((intent) => ({
        status: 400,
        body: { error: { code: "validation_failed", message: "secret", details: [detail] } },
        intent,
        classification: "INDETERMINATE",
      })),
      {
        status: 422,
        body: { error: { code: "validation_failed", message: "secret", details: [detail] } },
        intent: "phone-code-request",
        classification: "INDETERMINATE",
      },
      {
        status: 403,
        body: { error: { code: "registration_admission_required", message: "secret" } },
        intent: "phone-code-request",
        classification: "FORM",
      },
    ];
    for (const row of cases) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(row.body, { status: row.status })));
      const result = await host.createSignInAction()(
        createActionArgs(
          new Request("https://marketplace.test/sign-in", {
            method: "POST",
            body: new URLSearchParams({ intent: row.intent }),
          }),
        ),
      );
      expect(result).toMatchObject({
        classification: row.classification,
        intent: row.intent,
        errors: {
          fieldErrors: row.classification === "FIELD" ? { phone: ["Phone is required."] } : {},
          formErrors: row.classification === "FIELD" ? [] : [expect.any(String)],
        },
      });
      expect(JSON.stringify(result)).not.toContain("secret");
    }
  });

  it("rejects raw message and token markers", async () => {
    const marker = "Bearer synthetic-token-marker";
    const logs = [vi.spyOn(console, "error"), vi.spyOn(console, "warn")];
    for (const body of [{ error: marker }, { error: { code: "unknown", message: marker, token: marker } }]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body, { status: 401 })));
      const result = await host.createSignInAction()(createActionArgs(createPasswordSignInRequest()));
      expect(JSON.stringify(result)).not.toContain(marker);
      expect(result).toMatchObject({ errors: { fieldErrors: {} } });
    }
    expect(JSON.stringify(logs.map((log) => log.mock.calls))).not.toContain(marker);
    logs.forEach((log) => log.mockRestore());
  });

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

  const serverMintedRegistrationConsent = {
    bundleKey: "registration",
    requirements: [],
    resolvedAt: "2026-07-25T00:00:00.000Z",
    signature: "server-minted-test-signature",
  };

  function registrationFetchStub(sources: readonly SourceCommitPosition[]) {
    const registrationCalls: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      registrationCalls.push(new URL(url).pathname);
      if (url.endsWith("/registration-consent")) {
        return Response.json(serverMintedRegistrationConsent);
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

  it("returns safe method metadata without the submitted identifier after a password sign-in error", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(Response.json({ error: "Invalid email or password." }, { status: 401 })),
    );

    const result = await host.createSignInAction()(createActionArgs(createPasswordSignInRequest()));

    expect(result).toEqual({
      error: "Invalid email or password.",
      method: "password",
      intent: "password",
      classification: "FORM",
      errors: { fieldErrors: {}, formErrors: ["Invalid email or password."] },
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
    const timer = vi.spyOn(globalThis, "setTimeout");
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(createTransientAuthFetchError());
    vi.stubGlobal("fetch", fetch);

    const result = await host.createSignInAction()(createActionArgs(createPasswordSignInRequest()));

    expect(result).toEqual({
      error: "Sign-in is temporarily unavailable. Try again in a few seconds.",
      method: "password",
      intent: "password",
      classification: "FORM",
      errors: { fieldErrors: {}, formErrors: ["Sign-in is temporarily unavailable. Try again in a few seconds."] },
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(timer.mock.calls.map((call) => call[1])).toEqual([100, 250]);
    timer.mockRestore();
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

  it("registers with exactly the registration consent resolution it fetched, unaffirmed", async () => {
    const { fetch } = registrationFetchStub([identitySource]);
    vi.stubGlobal("fetch", fetch);

    await host.createRegisterAction()(createActionArgs(createPasswordRegistrationRequest()));

    const registration = fetch.mock.calls.find(([input]) => new URL(String(input)).pathname === "/api/auth/register");
    expect(JSON.parse(String(registration?.[1]?.body))).toEqual({
      displayName: "New Seller",
      email: "seller@example.test",
      password: "correct-password",
      registrationConsent: { resolution: serverMintedRegistrationConsent, affirmed: false },
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
