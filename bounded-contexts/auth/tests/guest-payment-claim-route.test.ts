import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFreshWriteToken } from "@chase-sets/http/responses";

const {
  mockClaimGuestCheckoutWithClaimContinuation,
  mockClaimGuestCheckoutWithPasskey,
  mockClaimGuestCheckoutWithMagicLink,
  mockClearGuestCheckoutCookie,
  mockCompleteBrowserAuthentication,
  mockCreateInternalAuthRequestApiClient,
  mockGetAccountPayment,
  mockRequestGuestCheckoutClaimLink,
  mockResolveActorFromAuthApi,
} = vi.hoisted(() => ({
  mockClaimGuestCheckoutWithClaimContinuation: vi.fn(),
  mockClaimGuestCheckoutWithPasskey: vi.fn(),
  mockClaimGuestCheckoutWithMagicLink: vi.fn(),
  mockClearGuestCheckoutCookie: vi.fn(),
  mockCompleteBrowserAuthentication: vi.fn(
    () =>
      new Response(null, {
        status: 302,
        headers: { Location: "/account/payments/pay_1" },
      }),
  ),
  mockCreateInternalAuthRequestApiClient: vi.fn(),
  mockGetAccountPayment: vi.fn(),
  mockRequestGuestCheckoutClaimLink: vi.fn(),
  mockResolveActorFromAuthApi: vi.fn(),
}));

vi.mock("../support/request-support/api-client", () => ({
  createInternalAuthRequestApiClient: mockCreateInternalAuthRequestApiClient,
}));
vi.mock("../support/route-support/auth-host", () => ({
  completeBrowserAuthentication: mockCompleteBrowserAuthentication,
}));
vi.mock("../support/auth-support/http", () => ({ clearGuestCheckoutCookie: mockClearGuestCheckoutCookie }));
vi.mock("@chase-sets/platform-runtime/auth", () => ({ resolveActorFromAuthApi: mockResolveActorFromAuthApi }));
import { createGuestPaymentClaimRoute } from "../support/route-support/guest-payment-claim/route";
const readClaimability = vi.fn(async (_request: Request, paymentId: string) => ({
  claimable: (await mockGetAccountPayment(paymentId)).status === "captured",
}));
const { action, loader } = createGuestPaymentClaimRoute(readClaimability);
const originalEnv = { ...process.env };
describe("guest payment claim route", () => {
  it("reads eligibility before claim context and never reads context for a noncaptured payment", async () => {
    const context = vi.fn(async () => ({
      accountId: "guest",
      paymentId: "pay_1",
      contactName: "Jane",
      contactEmail: "jane@example.com",
    }));
    mockCreateInternalAuthRequestApiClient.mockReturnValue({ getGuestCheckoutClaimContext: context });
    mockGetAccountPayment.mockResolvedValue({ status: "pending-confirmation" });
    const args = {
      request: new Request("https://marketplace.test/checkout/claim/pay_1"),
      params: { paymentId: "pay_1" },
      context: undefined,
    };
    expect(await loader(args)).toEqual({ paymentId: "pay_1", claimable: false, guestClaimContact: null });
    expect(context).not.toHaveBeenCalled();
    mockGetAccountPayment.mockResolvedValue({ status: "captured" });
    expect(await loader(args)).toEqual({
      paymentId: "pay_1",
      claimable: true,
      guestClaimContact: { contactName: "Jane", contactEmail: "jane@example.com" },
    });
    expect(readClaimability).toHaveBeenCalledTimes(2);
    expect(context).toHaveBeenCalledExactlyOnceWith({ paymentId: "pay_1" });
  });
  it.each([
    ["no email", { contactEmail: null, contactName: "Jane" }],
    ["no name", { contactEmail: "jane@example.com", contactName: null }],
    ["a blank name", { contactEmail: "jane@example.com", contactName: "  " }],
  ])("offers no claim for a contact Auth has not bound (%s)", async (_case, contact) => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockGetAccountPayment.mockResolvedValue({ status: "captured" });
    mockCreateInternalAuthRequestApiClient.mockReturnValue({
      getGuestCheckoutClaimContext: vi.fn(async () => ({ accountId: "guest", paymentId: "pay_1", ...contact })),
    });
    expect(
      await loader({
        request: new Request("https://marketplace.test/checkout/claim/pay_1"),
        params: { paymentId: "pay_1" },
        context: undefined,
      }),
    ).toEqual({ paymentId: "pay_1", claimable: true, guestClaimContact: null });
  });
  it.each([
    ["limited (429)", Object.assign(new Error("Too many requests."), { status: 429, body: null })],
    ["unreachable", new TypeError("fetch failed")],
  ])("still draws the claim page when Auth's claim context is %s, without a claim", async (_case, failure) => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockGetAccountPayment.mockResolvedValue({ status: "captured" });
    mockCreateInternalAuthRequestApiClient.mockReturnValue({
      getGuestCheckoutClaimContext: vi.fn(async () => {
        throw failure;
      }),
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(
        await loader({
          request: new Request("https://marketplace.test/checkout/claim/pay_1"),
          params: { paymentId: "pay_1" },
          context: undefined,
        }),
      ).toEqual({ paymentId: "pay_1", claimable: true, guestClaimContact: null });
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });
  it("redirects a non-guest actor before reading payment eligibility", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ roleKey: "owner" });
    await expect(
      loader({
        request: new Request("https://marketplace.test/checkout/claim/pay_1"),
        params: { paymentId: "pay_1" },
        context: undefined,
      }),
    ).rejects.toMatchObject({ status: 302, headers: expect.any(Headers) });
    expect(readClaimability).not.toHaveBeenCalled();
  });
  it.each(["claim-link-request", "claim-link-consume", "claim-passkey"])(
    "rereads eligibility on every direct %s POST and never mutates Auth on denial",
    async (intent) => {
      mockGetAccountPayment.mockResolvedValue({ status: "failed" });
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await action({
          request: new Request("https://marketplace.test/checkout/claim/pay_1", {
            method: "POST",
            body: new URLSearchParams({ intent, claimable: "true" }),
          }),
          params: { paymentId: "pay_1" },
          context: undefined,
        });
        expect(result).toEqual({ scope: "claim", error: "You can save this order after payment is complete." });
      }
      expect(readClaimability).toHaveBeenCalledTimes(2);
      expect(mockCreateInternalAuthRequestApiClient).not.toHaveBeenCalled();
    },
  );
  it.each([401, 403, 404, 500])("does not mutate Auth on a %s eligibility error", async (status) => {
    readClaimability.mockRejectedValue(
      Object.assign(new Error("original access failure"), { status, body: { error: { code: "denied" } } }),
    );
    const result = await action({
      request: new Request("https://marketplace.test/checkout/claim/pay_1", {
        method: "POST",
        body: new URLSearchParams({ intent: "claim-passkey" }),
      }),
      params: { paymentId: "pay_1" },
      context: undefined,
    });
    expect(result).toEqual({ scope: "claim", error: "original access failure" });
    expect(mockCreateInternalAuthRequestApiClient).not.toHaveBeenCalled();
  });
  it.each([401, 403, 404])("preserves the GET recovery response for %s", async (status) => {
    readClaimability.mockRejectedValue(
      Object.assign(new Error("original failure"), { status, body: { error: { code: "denied" } } }),
    );
    await expect(
      loader({
        request: new Request("https://marketplace.test/checkout/claim/pay_1"),
        params: { paymentId: "pay_1" },
        context: undefined,
      }),
    ).rejects.toMatchObject({ status: status === 404 ? 404 : 401 });
    expect(mockCreateInternalAuthRequestApiClient).not.toHaveBeenCalled();
  });
  it("does not swallow an unexpected eligibility failure", async () => {
    const failure = new Error("unexpected eligibility failure");
    readClaimability.mockRejectedValue(failure);
    await expect(
      loader({
        request: new Request("https://marketplace.test/checkout/claim/pay_1"),
        params: { paymentId: "pay_1" },
        context: undefined,
      }),
    ).rejects.toBe(failure);
  });
  it.each([404, 503])("preserves temporary freshness recovery for %s", async (status) => {
    readClaimability.mockRejectedValue(
      Object.assign(new Error("not caught up"), {
        status,
        body: { error: { code: status === 503 ? "projection_freshness_timeout" : "not_found" } },
      }),
    );
    const path = appendFreshWriteToken("/checkout/claim/pay_1", {
      mode: "eventual",
      commitPosition: "42",
      commitEventIds: ["evt_payment"],
      commitPositions: [{ sourceContextName: "payments", maxGlobalPosition: "42", eventIds: ["evt_payment"] }],
    });
    await expect(
      loader({
        request: new Request(`https://marketplace.test${path}`),
        params: { paymentId: "pay_1" },
        context: undefined,
      }),
    ).rejects.toMatchObject({ status: 503, statusText: "Preparing payment" });
    expect(mockCreateInternalAuthRequestApiClient).not.toHaveBeenCalled();
  });
  it("keeps expired freshness as permanent not-found", async () => {
    readClaimability.mockRejectedValue(
      Object.assign(new Error("missing"), { status: 404, body: { error: { code: "not_found" } } }),
    );
    const path = appendFreshWriteToken(
      "/checkout/claim/pay_1",
      { mode: "eventual", commitPosition: "42", commitEventIds: ["evt_payment"], commitPositions: [] },
      Date.now() - 300_000,
    );
    await expect(
      loader({
        request: new Request(`https://marketplace.test${path}`),
        params: { paymentId: "pay_1" },
        context: undefined,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
  beforeEach(() => {
    vi.resetAllMocks();
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockGetAccountPayment.mockResolvedValue({ status: "captured" });
    readClaimability.mockImplementation(async (_request, paymentId) => ({
      claimable: (await mockGetAccountPayment(paymentId)).status === "captured",
    }));
    mockCompleteBrowserAuthentication.mockImplementation(
      () => new Response(null, { status: 302, headers: { Location: "/account/payments/pay_1" } }),
    );
  });
  afterEach(() => {
    process.env = { ...originalEnv };
  });
  it("consumes an emailed claim continuation before loading the guest payment", async () => {
    const authResult = {
      type: "session-started",
      userId: "usr_1",
      sessionId: "ses_1",
      sessionToken: "session_token",
      session: { session_id: "ses_1" },
      memberships: [],
    };
    mockClaimGuestCheckoutWithClaimContinuation.mockResolvedValue(authResult);
    mockCreateInternalAuthRequestApiClient.mockReturnValue({
      claimGuestCheckoutWithClaimContinuation: mockClaimGuestCheckoutWithClaimContinuation,
    });

    let result: Response | null = null;
    try {
      await loader({
        request: new Request("http://localhost/checkout/claim/pay_1?claimContinuation=continuation_token", {
          headers: { cookie: "chase_sets_guest_checkout=guest_token" },
        }),
        params: { paymentId: "pay_1" },
        context: undefined,
      } as never);
    } catch (error) {
      result = error as Response;
    }

    expect(mockClaimGuestCheckoutWithClaimContinuation).toHaveBeenCalledWith({
      continuation: "continuation_token",
      paymentId: "pay_1",
    });
    expect(mockCompleteBrowserAuthentication).toHaveBeenCalledWith(expect.any(Request), authResult, {
      defaultSuccessPath: "/account/payments/pay_1",
      accountSelectionPath: "/account/select",
    });
    expect(mockClearGuestCheckoutCookie).toHaveBeenCalledWith(result?.headers, expect.any(Request));
    expect(mockGetAccountPayment).not.toHaveBeenCalled();
    expect(result?.status).toBe(302);
  });

  it("requests an email claim link without exposing the claim token by default", async () => {
    mockRequestGuestCheckoutClaimLink.mockResolvedValue({
      token: "magic_token",
      expiresAt: "2026-05-04T16:00:00.000Z",
    });
    mockCreateInternalAuthRequestApiClient.mockReturnValue({
      requestGuestCheckoutClaimLink: mockRequestGuestCheckoutClaimLink,
    });

    const form = new URLSearchParams();
    form.set("intent", "claim-link-request");
    form.set("displayName", "Jane Smith");
    form.set("email", "jane@example.com");

    const result = await action({
      request: new Request("http://localhost/checkout/claim/pay_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { paymentId: "pay_1" },
      context: undefined,
    } as never);

    expect(mockGetAccountPayment).toHaveBeenCalledWith("pay_1");
    expect(mockRequestGuestCheckoutClaimLink).toHaveBeenCalledWith({
      paymentId: "pay_1",
      origin: "http://localhost",
    });
    expect(result).toEqual({
      status: "claim-link-sent",
      token: null,
      expiresAt: "2026-05-04T16:00:00.000Z",
      displayName: "Jane Smith",
    });
  });

  it("exposes the guest claim token only for explicitly enabled local recovery outside production", async () => {
    process.env.GUEST_PAYMENT_CLAIM_LOCAL_RECOVERY_TOKEN_ENABLED = "true";
    mockRequestGuestCheckoutClaimLink.mockResolvedValue({
      token: "magic_token",
      expiresAt: "2026-05-04T16:00:00.000Z",
    });
    mockCreateInternalAuthRequestApiClient.mockReturnValue({
      requestGuestCheckoutClaimLink: mockRequestGuestCheckoutClaimLink,
    });

    const form = new URLSearchParams();
    form.set("intent", "claim-link-request");
    form.set("displayName", "Jane Smith");

    const result = await action({
      request: new Request("http://localhost/checkout/claim/pay_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { paymentId: "pay_1" },
      context: undefined,
    } as never);

    expect(result).toEqual({
      status: "claim-link-sent",
      token: "magic_token",
      expiresAt: "2026-05-04T16:00:00.000Z",
      displayName: "Jane Smith",
    });
  });

  it("does not expose the guest claim token in production even when local recovery is configured", async () => {
    process.env.NODE_ENV = "production";
    process.env.GUEST_PAYMENT_CLAIM_LOCAL_RECOVERY_TOKEN_ENABLED = "true";
    mockRequestGuestCheckoutClaimLink.mockResolvedValue({
      token: "magic_token",
      expiresAt: "2026-05-04T16:00:00.000Z",
    });
    mockCreateInternalAuthRequestApiClient.mockReturnValue({
      requestGuestCheckoutClaimLink: mockRequestGuestCheckoutClaimLink,
    });

    const form = new URLSearchParams();
    form.set("intent", "claim-link-request");
    form.set("displayName", "Jane Smith");

    const result = await action({
      request: new Request("http://localhost/checkout/claim/pay_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { paymentId: "pay_1" },
      context: undefined,
    } as never);

    expect(result).toEqual({
      status: "claim-link-sent",
      token: null,
      expiresAt: "2026-05-04T16:00:00.000Z",
      displayName: "Jane Smith",
    });
  });

  it("claims the guest account with passkey proof and starts a browser session", async () => {
    const authResult = {
      type: "session-started",
      userId: "usr_1",
      sessionId: "ses_1",
      sessionToken: "session_token",
      session: { session_id: "ses_1" },
      memberships: [],
    };
    mockClaimGuestCheckoutWithPasskey.mockResolvedValue(authResult);
    mockCreateInternalAuthRequestApiClient.mockReturnValue({
      claimGuestCheckoutWithPasskey: mockClaimGuestCheckoutWithPasskey,
    });

    const form = new URLSearchParams();
    form.set("intent", "claim-passkey");
    form.set("displayName", "Jane Smith");
    form.set("email", "jane@example.com");
    form.set("challengeId", "cmd_challenge");
    form.set("challenge", "challenge");
    form.set("externalCredentialId", "cred_external");
    form.set("label", "Passkey");
    form.set("webauthnResponse", "webauthn_response");

    const result = await action({
      request: new Request("http://localhost/checkout/claim/pay_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { paymentId: "pay_1" },
      context: undefined,
    } as never);

    expect(mockGetAccountPayment).toHaveBeenCalledWith("pay_1");
    expect(mockClaimGuestCheckoutWithPasskey).toHaveBeenCalledWith({
      displayName: "Jane Smith",
      email: "jane@example.com",
      paymentId: "pay_1",
      challengeId: "cmd_challenge",
      challenge: "challenge",
      externalCredentialId: "cred_external",
      label: "Passkey",
      webauthnResponse: "webauthn_response",
    });
    expect(mockCompleteBrowserAuthentication).toHaveBeenCalledWith(expect.any(Request), authResult, {
      defaultSuccessPath: "/account/payments/pay_1",
      accountSelectionPath: "/account/select",
    });
    expect(mockClearGuestCheckoutCookie).toHaveBeenCalledWith((result as Response).headers, expect.any(Request));
    expect((result as Response).status).toBe(302);
  });

  it("rejects manual guest claim token entry when local recovery is disabled", async () => {
    const form = new URLSearchParams();
    form.set("intent", "claim-link-consume");
    form.set("displayName", "Jane Smith");
    form.set("token", "magic_token");

    const result = await action({
      request: new Request("http://localhost/checkout/claim/pay_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { paymentId: "pay_1" },
      context: undefined,
    } as never);

    expect(result).toEqual({
      scope: "claim",
      error: "Claim token entry is not available here. Use the emailed link or request a new one.",
    });
    expect(mockClaimGuestCheckoutWithMagicLink).not.toHaveBeenCalled();
    expect(mockClearGuestCheckoutCookie).not.toHaveBeenCalled();
  });

  it("consumes a local recovery claim token only when explicitly enabled", async () => {
    process.env.GUEST_PAYMENT_CLAIM_LOCAL_RECOVERY_TOKEN_ENABLED = "true";
    const authResult = {
      type: "session-started",
      userId: "usr_1",
      sessionId: "ses_1",
      sessionToken: "session_token",
      session: { session_id: "ses_1" },
      memberships: [],
    };
    mockClaimGuestCheckoutWithMagicLink.mockResolvedValue(authResult);
    mockCreateInternalAuthRequestApiClient.mockReturnValue({
      claimGuestCheckoutWithMagicLink: mockClaimGuestCheckoutWithMagicLink,
    });

    const form = new URLSearchParams();
    form.set("intent", "claim-link-consume");
    form.set("displayName", "Jane Smith");
    form.set("token", "magic_token");

    const result = await action({
      request: new Request("http://localhost/checkout/claim/pay_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { paymentId: "pay_1" },
      context: undefined,
    } as never);

    expect(mockGetAccountPayment).toHaveBeenCalledWith("pay_1");
    expect(mockClaimGuestCheckoutWithMagicLink).toHaveBeenCalledWith({
      token: "magic_token",
      paymentId: "pay_1",
      displayName: "Jane Smith",
    });
    expect(mockClearGuestCheckoutCookie).toHaveBeenCalledWith((result as Response).headers, expect.any(Request));
    expect((result as Response).status).toBe(302);
  });
});
