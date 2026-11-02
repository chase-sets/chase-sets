import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import { readFreshWriteToken } from "@chase-sets/http/responses";
import { resolvePlatformPostWriteRequest } from "@chase-sets/platform-runtime/post-write-tokens";
import {
  applyCheckoutRouteMockDefaults,
  guestCheckoutActor,
  MockCheckoutApiError,
  mockConfirmCheckoutSession,
  mockCreateAuthRequestApiClient,
  mockCreateCartReadiness,
  mockCreateCheckoutRequestApiClient,
  mockCreateCheckoutSession,
  mockCreateIdentityRequestApiClient,
  mockCreateMarketplaceRequestApiClient,
  mockCreateOrderingRequestApiClient,
  mockCreatePaymentsRequestApiClient,
  mockGetCart,
  mockGetGuestCart,
  MockMarketplaceApiError,
  mockMergeGuestCartToAccount,
  mockPreviewCheckoutStatus,
  readyCartReadinessResponse,
  mockRequireActorFromAuthApi,
  mockResolveActorFromAuthApi,
  mockStartGuestCheckout,
} from "../tests/support/checkout-route-test-harness";

vi.mock("@chase-sets/platform-runtime/auth", async () => {
  const actual = await vi.importActual<typeof import("@chase-sets/platform-runtime/auth")>(
    "@chase-sets/platform-runtime/auth",
  );

  return {
    ...actual,
    requireActorFromAuthApi: mockRequireActorFromAuthApi,
    resolveActorFromAuthApi: mockResolveActorFromAuthApi,
  };
});

vi.mock("@chase-sets/auth/server", async () => {
  const actual = await vi.importActual<typeof import("@chase-sets/auth/server")>("@chase-sets/auth/server");

  return {
    ...actual,
    createAuthRequestApiClient: mockCreateAuthRequestApiClient,
  };
});

vi.mock("@chase-sets/identity/server", async () => {
  const actual = await vi.importActual<typeof import("@chase-sets/identity/server")>("@chase-sets/identity/server");

  return {
    ...actual,
    createIdentityRequestApiClient: mockCreateIdentityRequestApiClient,
  };
});

vi.mock("../support/request-support/api-client", () => ({
  CheckoutApiError: MockCheckoutApiError,
  createCheckoutRequestApiClient: mockCreateCheckoutRequestApiClient,
}));

vi.mock("@chase-sets/ordering/server", () => ({
  createOrderingRequestApiClient: mockCreateOrderingRequestApiClient,
}));

vi.mock("@chase-sets/payments/server", async () => {
  const actual = await vi.importActual<typeof import("@chase-sets/payments/server")>("@chase-sets/payments/server");

  return {
    ...actual,
    createPaymentsRequestApiClient: mockCreatePaymentsRequestApiClient,
    normalizeRequestedBalanceCreditAmount: (value: unknown) => {
      const text = String(value ?? "").trim();
      return text ? text : null;
    },
  };
});

vi.mock("@chase-sets/marketplace/server", () => ({
  createMarketplaceRequestApiClient: mockCreateMarketplaceRequestApiClient,
  MarketplaceApiError: MockMarketplaceApiError,
}));

import {
  action as checkoutStartAction,
  checkoutStartBuyerProtectionItems,
  checkoutStartHeaderCopy,
  loader as checkoutStartLoader,
} from "./checkout-start";

async function readRedirectFreshWriteToken(location: string | null) {
  const request = new Request(new URL(location ?? "", "http://localhost"));
  const resolvedRequest = await resolvePlatformPostWriteRequest(request);
  return readFreshWriteToken(resolvedRequest);
}

function checkoutSessionResult(sessionId: string, position = "42") {
  return {
    session_id: sessionId,
    commitPositions: [
      {
        sourceContextName: "checkout",
        maxGlobalPosition: position,
        eventIds: [`evt_${sessionId}`],
      },
    ],
  };
}

function guestStart(guestToken = "guest_token", accountId = "acc_guest") {
  return { accountId, guestToken, expiresAt: "2099-01-01T00:00:00.000Z" };
}

/** Auth resolves the guest-buyer only when the request presents that guest's cookie. */
function resolveGuestFromCookie(guestToken = "guest_token") {
  mockResolveActorFromAuthApi.mockImplementation(async ({ request }: { request: Request }) =>
    (request.headers.get("cookie") ?? "").includes(`chase_sets_guest_checkout=${guestToken}`)
      ? guestCheckoutActor()
      : null,
  );
}

/** One start POST as the browser sends it, presenting the cookies it holds. */
async function postStart(url: string, body: URLSearchParams, cookie = "") {
  return (await checkoutStartAction({
    request: new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) },
      body: body.toString(),
    }),
    params: {},
    context: undefined,
  } as never)) as Response;
}

/** The `name=value` pairs a response asks the browser to store. */
function setCookiePairs(response: Response) {
  return response.headers.getSetCookie().map((cookie) => cookie.split(";")[0] ?? "");
}

/**
 * Follows a guest entry `307` as a browser does: the same method and body to
 * its Location, presenting the cookies the browser already held plus the ones
 * the hop set.
 */
async function followGuestEntry(hop: Response, body: URLSearchParams, heldCookie = "", origin = "http://localhost") {
  expect(hop.status).toBe(307);
  expect(hop.headers.get("X-Remix-Reload-Document")).toBeNull();
  const location = new URL(hop.headers.get("Location") ?? "", origin);
  expect(location.pathname).toBe("/checkout/buy/readiness");
  expect(location.searchParams.get("guestEntry")).toBe("1");
  return postStart(location.toString(), body, [heldCookie, ...setCookiePairs(hop)].filter(Boolean).join("; "));
}

const buyNowStartUrl =
  "http://localhost/checkout/buy/readiness?source=buy-now&listingId=lst_1&fulfillmentMode=locked-listing&lockedListingId=lst_1&catalogItemId=cat_1&productId=prod_1&itemTitle=Charizard&quantity=1";

/**
 * A browser and the owners behind guest entry. The browser keeps one cookie
 * jar across every POST and may lose a response (its cookies never arrive) or
 * refuse cookies. Auth mints contact-less guests. Checkout resolves the
 * account from the cookie its client presents and, as #9994 does, opens one
 * Session per account and entry key and replays it for the same pair.
 */
function guestEntryWorld(options: { refuseCookies?: boolean } = {}) {
  const jar = new Map<string, string>();
  const guests = new Map<string, { accountId: string; expired: boolean; refused: boolean }>();
  const sessions: Array<{ sessionId: string; accountId: string; entryAttemptKey: string }> = [];
  const checkoutCalls: string[] = [];

  const presentedGuest = (cookieHeader: string | null | undefined) => {
    const token = /(?:^|;\s*)chase_sets_guest_checkout=([^;]+)/.exec(cookieHeader ?? "")?.[1];
    const guest = token ? guests.get(decodeURIComponent(token)) : undefined;
    return guest && !guest.expired ? guest : null;
  };

  mockStartGuestCheckout.mockImplementation(async () => {
    const minted = guests.size + 1;
    const guest = guestStart(`guest_token_${minted}`, `acc_guest_${minted}`);
    guests.set(guest.guestToken, { accountId: guest.accountId, expired: false, refused: false });
    return guest;
  });
  mockCreateAuthRequestApiClient.mockReturnValue({ startGuestCheckout: mockStartGuestCheckout });
  mockResolveActorFromAuthApi.mockImplementation(async ({ request }: { request: Request }) => {
    const guest = presentedGuest(request.headers.get("cookie"));
    return guest ? { ...guestCheckoutActor(), accountId: guest.accountId } : null;
  });
  mockCreateCheckoutRequestApiClient.mockImplementation(
    (request: Request, clientOptions?: { headers?: Record<string, string> }) => {
      // A client presents the cookie it was built with, else the request's own.
      const guest = presentedGuest(clientOptions?.headers?.cookie ?? request.headers.get("cookie"));
      const called =
        <T>(name: string, answer: () => T) =>
        async () => {
          checkoutCalls.push(name);
          return answer();
        };
      return {
        getGuestCart: called("getGuestCart", () => ({ items: [], count: 1 })),
        mergeGuestCartToAccount: called("mergeGuestCartToAccount", () => ({ status: "merged" })),
        createCartReadiness: called("createCartReadiness", readyCartReadinessResponse),
        createCheckoutSession: async (body: { entryAttemptKey?: string }) => {
          checkoutCalls.push("createCheckoutSession");
          if (!guest) throw new MockCheckoutApiError(401, { error: { code: "authentication_required" } });
          if (guest.refused) throw new MockCheckoutApiError(403, { error: { code: "authorization_forbidden" } });
          const entryAttemptKey = body.entryAttemptKey ?? "";
          const first = sessions.find(
            (session) => session.accountId === guest.accountId && session.entryAttemptKey === entryAttemptKey,
          );
          if (first) return checkoutSessionResult(first.sessionId);
          const opened = {
            sessionId: `chk_guest_entry_${sessions.length + 1}`,
            accountId: guest.accountId,
            entryAttemptKey,
          };
          sessions.push(opened);
          return checkoutSessionResult(opened.sessionId);
        },
      };
    },
  );

  const store = (response: Response) => {
    if (options.refuseCookies) return;
    for (const pair of setCookiePairs(response)) {
      const [name = "", value = ""] = pair.split("=");
      if (value) jar.set(name, value);
      else jar.delete(name);
    }
  };
  const cookieHeader = () => [...jar].map(([name, value]) => `${name}=${value}`).join("; ");

  return {
    jar,
    guests,
    sessions,
    checkoutCalls,
    cookieHeader,
    /** Applies a response the browser received: it stores the cookies the response set. */
    receive(response: Response) {
      store(response);
      return response;
    },
    /** One POST from the browser. An undelivered response never reaches it, so its cookies are lost. */
    async post(url: string, body: URLSearchParams, { delivered = true } = {}) {
      const response = await postStart(new URL(url, "http://localhost").toString(), body, cookieHeader());
      if (delivered && response instanceof Response) store(response);
      return response;
    },
    expireGuest(guestToken: string) {
      guests.get(guestToken)!.expired = true;
    },
    refuseGuest(guestToken: string) {
      guests.get(guestToken)!.refused = true;
    },
    ownedSessions(accountId: string) {
      return sessions.filter((session) => session.accountId === accountId);
    },
  };
}

function buyNowEntryForm(entryAttemptKey = "chkentry_01JGUESTENTRYBINDS0001") {
  const form = new URLSearchParams();
  form.set("entryAttemptKey", entryAttemptKey);
  form.set("source", "buy-now");
  return form;
}

describe("checkout web routes: checkout start", () => {
  beforeEach(() => {
    applyCheckoutRouteMockDefaults();
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.unstubAllEnvs();
  });

  it("starts cart checkout through the canonical checkout session API", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({});
    mockCreateCheckoutSession.mockResolvedValue({ session_id: "chk_cart" });
    mockMergeGuestCartToAccount.mockResolvedValue({ status: "merged" });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      createCartReadiness: mockCreateCartReadiness,
      createCheckoutSession: mockCreateCheckoutSession,
      mergeGuestCartToAccount: mockMergeGuestCartToAccount,
    });

    const form = new URLSearchParams();
    form.set("source", "cart");
    form.set("readinessSnapshotId", "cr_ready");
    form.set("readinessSourceRevision", "cr_source");
    form.set(
      "readinessDecisions",
      JSON.stringify({ optimization: { decision: "declined", lineId: "cli_1", listingId: "lst_lower" } }),
    );

    const response = (await checkoutStartAction({
      request: new Request("http://localhost/checkout/buy/readiness", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          cookie: "chase_sets_anonymous_cart=anon_cart_1",
        },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never)) as Response;

    expect(mockMergeGuestCartToAccount).toHaveBeenCalledWith("anon_cart_1");
    expect(mockCreateCartReadiness).toHaveBeenCalledWith({
      lineOutcomes: [],
      optimization: { decision: "declined", lineId: "cli_1", listingId: "lst_lower" },
    });
    expect(mockCreateCheckoutSession).toHaveBeenCalledWith({
      source: {
        type: "cart",
        readinessSnapshotId: "cr_ready",
        readinessSourceRevision: "cr_source",
        readinessDecisions: {
          lineOutcomes: [],
          optimization: { decision: "declined", lineId: "cli_1", listingId: "lst_lower" },
        },
      },
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/checkout/buy/session/chk_cart");
    expect(response.headers.getSetCookie().join("; ")).toContain("chase_sets_anonymous_cart=");
  });

  it("refreshes signed-in cart readiness instead of trusting cart-page display snapshot fields", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer", permissions: [] });
    mockCreateCheckoutSession.mockResolvedValue({ session_id: "chk_cart" });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      createCartReadiness: mockCreateCartReadiness,
      createCheckoutSession: mockCreateCheckoutSession,
      mergeGuestCartToAccount: mockMergeGuestCartToAccount,
    });

    const form = new URLSearchParams();
    form.set("source", "cart");
    form.set("readinessSnapshotId", "cr_display_only");
    form.set("readinessSourceRevision", "cr_display_revision");
    form.set(
      "readinessDecisions",
      JSON.stringify({ optimization: { decision: "declined", lineId: "cli_1", listingId: "lst_lower" } }),
    );

    const response = (await checkoutStartAction({
      request: new Request("http://localhost/checkout/buy/readiness", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never)) as Response;

    expect(mockMergeGuestCartToAccount).not.toHaveBeenCalled();
    expect(mockCreateCartReadiness).toHaveBeenCalledWith({
      lineOutcomes: [],
      optimization: { decision: "declined", lineId: "cli_1", listingId: "lst_lower" },
    });
    expect(mockCreateCheckoutSession).toHaveBeenCalledWith({
      source: {
        type: "cart",
        readinessSnapshotId: "cr_ready",
        readinessSourceRevision: "cr_source",
        readinessDecisions: {
          lineOutcomes: [],
          optimization: { decision: "declined", lineId: "cli_1", listingId: "lst_lower" },
        },
      },
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/checkout/buy/session/chk_cart");
  });

  it("keeps signed-out buyers on the checkout start choice page with a checkout return target", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockGetGuestCart.mockResolvedValue({ items: [], count: 2 });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getGuestCart: mockGetGuestCart,
    });

    const result = await checkoutStartLoader({
      request: new Request("http://localhost/checkout/buy/readiness"),
      params: {},
      context: undefined,
    } as never);

    expect(result).toEqual({
      isSignedIn: false,
      isGuestBuyer: false,
      source: null,
      cartReadiness: null,
      cartCount: 2,
      entryAttemptKey: expect.stringMatching(/^chkentry_/),
      signInPath: "/sign-in?returnTo=%2Fcheckout%2Fbuy%2Freadiness",
    });
    expect(mockGetGuestCart).toHaveBeenCalledWith(null);
    expect(mockStartGuestCheckout).not.toHaveBeenCalled();
    expect(mockMergeGuestCartToAccount).not.toHaveBeenCalled();
    expect(mockCreateCartReadiness).not.toHaveBeenCalled();
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
  });

  it("marks guest checkout actors separately from registered signed-in accounts on checkout start", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(guestCheckoutActor());
    mockCreateCheckoutRequestApiClient.mockReturnValue({});

    const result = await checkoutStartLoader({
      request: new Request("http://localhost/checkout/buy/readiness"),
      params: {},
      context: undefined,
    } as never);

    expect(result).toEqual({
      isSignedIn: false,
      isGuestBuyer: true,
      source: null,
      cartReadiness: null,
      cartCount: 0,
      entryAttemptKey: expect.stringMatching(/^chkentry_/),
      signInPath: "/sign-in?returnTo=%2Fcheckout%2Fbuy%2Freadiness",
    });
  });

  it("returns checkout-owned recovery instead of creating a guest account for an empty signed-out cart", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockGetGuestCart.mockResolvedValue({ items: [], count: 0 });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getGuestCart: mockGetGuestCart,
      createCartReadiness: mockCreateCartReadiness,
      createCheckoutSession: mockCreateCheckoutSession,
      mergeGuestCartToAccount: mockMergeGuestCartToAccount,
    });

    const form = new URLSearchParams();
    form.set("source", "cart");

    const result = await checkoutStartAction({
      request: new Request("http://localhost/checkout/buy/readiness", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never);

    expect(result).toEqual({
      recovery: expect.objectContaining({
        kind: "cart-empty",
        title: "Your Buy Cart is empty",
        primaryAction: expect.objectContaining({ href: "/account/cart" }),
        secondaryAction: expect.objectContaining({ href: "/search" }),
      }),
    });
    expect(mockStartGuestCheckout).not.toHaveBeenCalled();
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
  });

  it("starts signed-out cart checkout through the guest entry hop without guest contact fields", async () => {
    resolveGuestFromCookie();
    mockStartGuestCheckout.mockResolvedValue(guestStart());
    mockCreateAuthRequestApiClient.mockReturnValue({
      startGuestCheckout: mockStartGuestCheckout,
    });
    mockGetGuestCart.mockResolvedValue({ items: [], count: 1 });
    mockCreateCheckoutSession.mockResolvedValue({ session_id: "chk_guest_one_post" });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getGuestCart: mockGetGuestCart,
      createCartReadiness: mockCreateCartReadiness,
      createCheckoutSession: mockCreateCheckoutSession,
      mergeGuestCartToAccount: mockMergeGuestCartToAccount,
    });

    const form = new URLSearchParams();
    form.set("source", "cart");
    form.set("readinessSnapshotId", "cr_ready");
    form.set("readinessSourceRevision", "cr_source");
    const anonymousCart = "chase_sets_anonymous_cart=anon_cart_1";

    const hop = await postStart("http://localhost/checkout/buy/readiness", form, anonymousCart);

    expect(mockGetGuestCart).toHaveBeenCalledWith("anon_cart_1");
    expect(mockStartGuestCheckout).toHaveBeenCalledOnce();
    expect(mockStartGuestCheckout).toHaveBeenCalledWith({});
    expect(mockMergeGuestCartToAccount).not.toHaveBeenCalled();
    expect(mockCreateCartReadiness).not.toHaveBeenCalled();
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();

    const result = await followGuestEntry(hop, form, anonymousCart);

    expect(result.headers.get("Location")).toBe("/checkout/buy/session/chk_guest_one_post");
    expect(mockStartGuestCheckout).toHaveBeenCalledOnce();
    expect(mockMergeGuestCartToAccount).toHaveBeenCalledWith("anon_cart_1");
    expect(mockCreateCartReadiness).toHaveBeenCalledWith({});
    expect(mockCreateCheckoutSession).toHaveBeenCalledOnce();
  });

  it("returns checkout-owned recovery when guest-buyer checkout reentry starts from an empty cart", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(guestCheckoutActor());
    mockCreateCheckoutSession.mockRejectedValue(
      new MockCheckoutApiError(400, {
        error: {
          code: "cart_empty",
          message: "Cart must contain at least one line.",
        },
      }),
    );
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      createCartReadiness: mockCreateCartReadiness,
      createCheckoutSession: mockCreateCheckoutSession,
      mergeGuestCartToAccount: mockMergeGuestCartToAccount,
    });

    const form = new URLSearchParams();
    form.set("source", "cart");

    const result = await checkoutStartAction({
      request: new Request("http://localhost/checkout/buy/readiness", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          cookie: "chase_sets_guest_checkout=guest_token",
        },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never);

    expect(result).toEqual({
      recovery: expect.objectContaining({
        kind: "cart-empty",
        description: "Add items to your Buy Cart before starting checkout.",
      }),
    });
    expect(mockMergeGuestCartToAccount).not.toHaveBeenCalled();
  });

  it("still throws unknown checkout-start failures", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(guestCheckoutActor());
    mockCreateCheckoutSession.mockRejectedValue(new Error("database unavailable"));
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      createCartReadiness: mockCreateCartReadiness,
      createCheckoutSession: mockCreateCheckoutSession,
    });

    const form = new URLSearchParams();
    form.set("source", "cart");

    await expect(
      checkoutStartAction({
        request: new Request("http://localhost/checkout/buy/readiness", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: form.toString(),
        }),
        params: {},
        context: undefined,
      } as never),
    ).rejects.toThrow("database unavailable");
  });

  it("preserves buy-now checkout intent in the sign-in return target", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockCreateCheckoutRequestApiClient.mockReturnValue({});

    const result = await checkoutStartLoader({
      request: new Request(
        "http://localhost/checkout/buy/readiness?source=buy-now&listingId=lst_1&catalogItemId=cat_1&productId=prod_1&itemTitle=Charizard&quantity=1",
      ),
      params: {},
      context: undefined,
    } as never);

    expect(result.isSignedIn).toBe(false);
    expect(result.source).toEqual(
      expect.objectContaining({
        type: "buy-now",
        listingId: "lst_1",
        catalogItemId: "cat_1",
      }),
    );
    expect(result.signInPath).toBe(
      "/sign-in?returnTo=%2Fcheckout%2Fbuy%2Freadiness%3Fsource%3Dbuy-now%26listingId%3Dlst_1%26catalogItemId%3Dcat_1%26productId%3Dprod_1%26itemTitle%3DCharizard%26quantity%3D1",
    );
  });

  it("loads current signed-in cart readiness after sign-in returns to checkout start", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer" });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      createCartReadiness: mockCreateCartReadiness,
    });

    const result = await checkoutStartLoader({
      request: new Request("http://localhost/checkout/buy/readiness"),
      params: {},
      context: undefined,
    } as never);

    expect(result).toEqual({
      isSignedIn: true,
      isGuestBuyer: false,
      source: null,
      cartReadiness: {
        status: "ready",
        lineCount: 1,
        customerSafeFacts: ["Ready for checkout."],
      },
      cartCount: 1,
      entryAttemptKey: expect.stringMatching(/^chkentry_/),
      signInPath: "/sign-in?returnTo=%2Fcheckout%2Fbuy%2Freadiness",
    });
    expect(mockCreateCartReadiness).toHaveBeenCalledWith({});
    expect(mockGetGuestCart).not.toHaveBeenCalled();
  });

  it("represents blocked signed-in cart readiness on the checkout start loader", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer" });
    mockCreateCartReadiness.mockResolvedValueOnce({
      readiness: {
        ...readyCartReadinessResponse().readiness,
        snapshotId: "cr_blocked",
        status: "blocked",
        lineCount: 1,
        includedLineIds: [],
        unresolvedLineIds: ["cli_air_balloon"],
        lineOutcomes: [{ lineId: "cli_air_balloon", outcome: "checkout", reason: "shipping-measure-missing" }],
        customerSafeFacts: ["No cart items are ready for checkout."],
      },
    });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      createCartReadiness: mockCreateCartReadiness,
    });

    const result = await checkoutStartLoader({
      request: new Request("http://localhost/checkout/buy/readiness"),
      params: {},
      context: undefined,
    } as never);

    expect(result).toEqual(
      expect.objectContaining({
        isSignedIn: true,
        source: null,
        cartCount: 1,
        cartReadiness: {
          status: "blocked",
          lineCount: 1,
          customerSafeFacts: ["No cart items are ready for checkout."],
        },
      }),
    );
    expect(mockGetGuestCart).not.toHaveBeenCalled();
  });

  it("starts signed-in buy-now checkout from the preserved checkout start payload", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer" });
    mockCreateCheckoutSession.mockResolvedValue(checkoutSessionResult("chk_buy_now"));
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      createCheckoutSession: mockCreateCheckoutSession,
      mergeGuestCartToAccount: mockMergeGuestCartToAccount,
    });

    const form = new URLSearchParams();
    form.set("entryAttemptKey", "chkentry_01JSTARTENTRYKEY000001");
    form.set("source", "buy-now");
    form.set("listingId", "lst_1");
    form.set("catalogItemId", "cat_1");
    form.set("productId", "prod_1");
    form.set("itemTitle", "Charizard");
    form.set("itemSubtitle", "Base Set");
    form.set("selectedOptions", JSON.stringify([{ dimensionId: "condition", optionId: "raw" }]));
    form.set("productSummary", "Raw");
    form.set("quantity", "2");

    const response = (await checkoutStartAction({
      request: new Request("http://localhost/checkout/buy/readiness", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never)) as Response;

    expect(mockMergeGuestCartToAccount).not.toHaveBeenCalled();
    expect(mockCreateCheckoutSession).toHaveBeenCalledWith({
      entryAttemptKey: "chkentry_01JSTARTENTRYKEY000001",
      source: {
        type: "buy-now",
        listingId: "lst_1",
        catalogItemId: "cat_1",
        productId: "prod_1",
        itemTitle: "Charizard",
        itemSubtitle: "Base Set",
        selectedOptions: [{ dimensionId: "condition", optionId: "raw" }],
        productSummary: "Raw",
        priceAmount: null,
        priceCurrencyCode: null,
        sellerName: null,
        availability: null,
        fulfillment: null,
        fulfillmentMode: "optimize",
        lockedListingId: null,
        quantity: 2,
      },
    });
    expect(response.status).toBe(302);
    const redirectUrl = new URL(response.headers.get("Location") ?? "", "http://localhost");
    expect(redirectUrl.pathname).toBe("/checkout/buy/session/chk_buy_now");
    expect(await readRedirectFreshWriteToken(redirectUrl.toString())).toMatchObject({
      sources: [
        {
          sourceContextName: "checkout",
          maxGlobalPosition: "42",
          eventIds: ["evt_chk_buy_now"],
        },
      ],
    });
  });

  it("starts signed-out buy-now checkout with a guest cookie on the hop and a fresh checkout receipt", async () => {
    resolveGuestFromCookie();
    mockStartGuestCheckout.mockResolvedValue(guestStart());
    mockCreateAuthRequestApiClient.mockReturnValue({
      startGuestCheckout: mockStartGuestCheckout,
    });
    mockCreateCheckoutSession.mockResolvedValue(checkoutSessionResult("chk_guest_buy_now"));
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      createCheckoutSession: mockCreateCheckoutSession,
    });

    const form = new URLSearchParams();
    form.set("entryAttemptKey", "chkentry_01JSTARTENTRYKEY000001");
    form.set("source", "cart");
    form.set("listingId", "lst_tampered");
    form.set("fulfillmentMode", "locked-listing");
    form.set("lockedListingId", "lst_tampered");
    form.set("catalogItemId", "cat_tampered");
    form.set("productId", "prod_tampered");
    form.set("itemTitle", "Tampered");
    form.set("selectedOptions", "[]");
    form.set("quantity", "99");

    const hop = await postStart(
      "http://localhost/checkout/buy/readiness?source=buy-now&listingId=lst_1&fulfillmentMode=locked-listing&lockedListingId=lst_1&catalogItemId=cat_1&productId=prod_1&itemTitle=Charizard&selectedOptions=%5B%7B%22dimensionId%22%3A%22condition%22%2C%22optionId%22%3A%22raw%22%7D%5D&quantity=1",
      form,
    );

    expect(mockStartGuestCheckout).toHaveBeenCalledWith({});
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
    expect(setCookiePairs(hop)).toEqual(["chase_sets_guest_checkout=guest_token"]);

    const response = await followGuestEntry(hop, form);
    const redirectUrl = new URL(response.headers.get("Location") ?? "", "http://localhost");

    expect(mockStartGuestCheckout).toHaveBeenCalledOnce();
    expect(mockCreateCheckoutSession).toHaveBeenCalledWith({
      entryAttemptKey: "chkentry_01JSTARTENTRYKEY000001",
      source: expect.objectContaining({
        type: "buy-now",
        listingId: "lst_1",
        fulfillmentMode: "locked-listing",
        lockedListingId: "lst_1",
        catalogItemId: "cat_1",
        productId: "prod_1",
        itemTitle: "Charizard",
        selectedOptions: [{ dimensionId: "condition", optionId: "raw" }],
        quantity: 1,
      }),
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("X-Remix-Reload-Document")).toBe("true");
    expect(redirectUrl.pathname).toBe("/checkout/buy/session/chk_guest_buy_now");
    expect(await readRedirectFreshWriteToken(redirectUrl.toString())).toMatchObject({
      sources: [
        {
          sourceContextName: "checkout",
          maxGlobalPosition: "42",
          eventIds: ["evt_chk_guest_buy_now"],
        },
      ],
    });
  });

  it("refuses a keyless signed-out buy-now entry before minting a guest or sending any command", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockCreateAuthRequestApiClient.mockReturnValue({ startGuestCheckout: mockStartGuestCheckout });
    mockCreateCheckoutRequestApiClient.mockReturnValue({ createCheckoutSession: mockCreateCheckoutSession });
    const form = new URLSearchParams();
    form.set("source", "buy-now");

    const result = await checkoutStartAction({
      request: new Request(
        "http://localhost/checkout/buy/readiness?source=buy-now&listingId=lst_1&fulfillmentMode=locked-listing&lockedListingId=lst_1&catalogItemId=cat_1&productId=prod_1&itemTitle=Charizard&quantity=1",
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: form.toString(),
        },
      ),
      params: {},
      context: undefined,
    } as never);

    expect(result).toMatchObject({ recovery: { kind: "attempt-changed", recoveryKind: "action-required" } });
    expect(mockStartGuestCheckout).not.toHaveBeenCalled();
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
  });

  it("hands a guest whose access no longer matches to a fresh guest through the entry hop, with no Session write in that request", async () => {
    mockResolveActorFromAuthApi.mockImplementation(async ({ request }: { request: Request }) => {
      const cookie = request.headers.get("cookie") ?? "";
      if (cookie.includes("chase_sets_guest_checkout=guest_token_recovered")) {
        return { ...guestCheckoutActor(), accountId: "acc_guest_recovered" };
      }
      return cookie.includes("chase_sets_guest_checkout=stale_guest_token") ? guestCheckoutActor() : null;
    });
    const blockedCreateCheckoutSession = vi.fn(async () => {
      throw new MockCheckoutApiError(403, {
        error: { code: "authorization_forbidden", message: "Forbidden." },
      });
    });
    const recoveredCreateCheckoutSession = vi.fn(async () => ({ session_id: "chk_guest_recovered" }));
    mockStartGuestCheckout.mockResolvedValue({
      accountId: "acc_guest_recovered",
      guestToken: "guest_token_recovered",
      expiresAt: "2026-04-02T00:00:00.000Z",
    });
    mockCreateAuthRequestApiClient.mockReturnValue({
      startGuestCheckout: mockStartGuestCheckout,
    });
    mockCreateCheckoutRequestApiClient
      .mockReturnValueOnce({
        createCheckoutSession: blockedCreateCheckoutSession,
        mergeGuestCartToAccount: mockMergeGuestCartToAccount,
      })
      .mockReturnValueOnce({
        createCheckoutSession: recoveredCreateCheckoutSession,
        mergeGuestCartToAccount: mockMergeGuestCartToAccount,
      });

    const form = new URLSearchParams();
    form.set("entryAttemptKey", "chkentry_01JSTARTENTRYKEY000001");
    form.set("source", "buy-now");
    form.set("listingId", "lst_1");
    form.set("catalogItemId", "cat_1");
    form.set("productId", "prod_1");
    form.set("itemTitle", "Charizard");
    form.set("selectedOptions", JSON.stringify([{ dimensionId: "condition", optionId: "raw" }]));
    form.set("quantity", "1");

    const hop = await postStart(
      "http://localhost/checkout/buy/readiness",
      form,
      "chase_sets_guest_checkout=stale_guest_token",
    );

    expect(blockedCreateCheckoutSession).toHaveBeenCalledWith({
      entryAttemptKey: "chkentry_01JSTARTENTRYKEY000001",
      source: expect.objectContaining({
        type: "buy-now",
        listingId: "lst_1",
        catalogItemId: "cat_1",
        productId: "prod_1",
        itemTitle: "Charizard",
      }),
    });
    expect(mockStartGuestCheckout).toHaveBeenCalledOnce();
    expect(mockStartGuestCheckout).toHaveBeenCalledWith({});
    expect(recoveredCreateCheckoutSession).not.toHaveBeenCalled();
    expect(setCookiePairs(hop)).toEqual(["chase_sets_guest_checkout=guest_token_recovered"]);

    // The browser replaces the stale guest cookie with the one the hop set.
    const response = await followGuestEntry(hop, form);

    expect(mockStartGuestCheckout).toHaveBeenCalledOnce();
    expect(blockedCreateCheckoutSession).toHaveBeenCalledOnce();
    expect(recoveredCreateCheckoutSession).toHaveBeenCalledOnce();
    expect(recoveredCreateCheckoutSession).toHaveBeenCalledWith({
      entryAttemptKey: "chkentry_01JSTARTENTRYKEY000001",
      source: expect.objectContaining({
        type: "buy-now",
        listingId: "lst_1",
        catalogItemId: "cat_1",
        productId: "prod_1",
        itemTitle: "Charizard",
      }),
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/checkout/buy/session/chk_guest_recovered");
    expect(response.headers.get("X-Remix-Reload-Document")).toBe("true");
    expect(mockConfirmCheckoutSession).not.toHaveBeenCalled();
  });

  it("takes the shipped start recovery, not another guest, when the followed guest entry is refused", async () => {
    resolveGuestFromCookie();
    mockStartGuestCheckout.mockResolvedValue(guestStart());
    mockCreateAuthRequestApiClient.mockReturnValue({ startGuestCheckout: mockStartGuestCheckout });
    mockCreateCheckoutSession.mockRejectedValue(
      new MockCheckoutApiError(403, { error: { code: "authorization_forbidden", message: "Forbidden." } }),
    );
    mockCreateCheckoutRequestApiClient.mockReturnValue({ createCheckoutSession: mockCreateCheckoutSession });
    const form = buyNowEntryForm();

    const hop = await postStart(buyNowStartUrl, form);
    const result = await followGuestEntry(hop, form);

    expect(result).toEqual({
      recovery: expect.objectContaining({ kind: "guest-access-expired", recoveryKind: "action-required" }),
    });
    expect(mockStartGuestCheckout).toHaveBeenCalledOnce();
    expect(mockCreateCheckoutSession).toHaveBeenCalledOnce();
  });

  it("keeps signed-in wrong-account checkout start protected", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_other", permissions: [] });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      createCheckoutSession: vi.fn(async () => {
        throw new MockCheckoutApiError(403, {
          error: { code: "authorization_forbidden", message: "Forbidden." },
        });
      }),
      mergeGuestCartToAccount: mockMergeGuestCartToAccount,
    });

    const form = new URLSearchParams();
    form.set("entryAttemptKey", "chkentry_01JSTARTENTRYKEY000002");
    form.set("source", "buy-now");
    form.set("listingId", "lst_1");
    form.set("catalogItemId", "cat_1");
    form.set("productId", "prod_1");
    form.set("itemTitle", "Charizard");
    form.set("selectedOptions", "[]");
    form.set("quantity", "1");

    const result = await checkoutStartAction({
      request: new Request("http://localhost/checkout/buy/readiness", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never);

    expect(result).toEqual({
      recovery: expect.objectContaining({
        kind: "wrong-account",
        title: "Checkout belongs to another account",
      }),
    });
    expect(mockStartGuestCheckout).not.toHaveBeenCalled();
  });

  it("uses the authoritative offer-intent URL over conflicting form data", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue({ accountId: "acc_buyer" });
    mockCreateCheckoutSession.mockResolvedValue({ session_id: "chk_offer" });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      createCheckoutSession: mockCreateCheckoutSession,
      mergeGuestCartToAccount: mockMergeGuestCartToAccount,
    });

    const form = new URLSearchParams();
    form.set("entryAttemptKey", "chkentry_01JSTARTOFFERKEY000001");
    form.set("source", "buy-now");
    form.set("listingId", "lst_tampered");
    form.set("catalogItemId", "cat_tampered");
    form.set("productId", "prod_tampered");
    form.set("itemTitle", "Tampered");
    form.set("selectedOptions", "[]");
    form.set("quantity", "99");

    const response = (await checkoutStartAction({
      request: new Request(
        "http://localhost/checkout/buy/readiness?source=offer-intent&catalogItemId=cat_1&productId=prod_1&itemTitle=Charizard&itemSubtitle=Base+Set&selectedOptions=%5B%7B%22dimensionId%22%3A%22condition%22%2C%22optionId%22%3A%22raw%22%7D%5D&productSummary=Raw&offerPriceAmount=350.00&offerPriceCurrencyCode=EUR&quantity=2",
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: form.toString(),
        },
      ),
      params: {},
      context: undefined,
    } as never)) as Response;

    expect(mockMergeGuestCartToAccount).not.toHaveBeenCalled();
    expect(mockCreateCheckoutSession).toHaveBeenCalledWith({
      entryAttemptKey: "chkentry_01JSTARTOFFERKEY000001",
      source: {
        type: "offer-intent",
        catalogItemId: "cat_1",
        productId: "prod_1",
        itemTitle: "Charizard",
        itemSubtitle: "Base Set",
        selectedOptions: [{ dimensionId: "condition", optionId: "raw" }],
        productSummary: "Raw",
        offerPriceAmount: "350.00",
        offerPriceCurrencyCode: "EUR",
        quantity: 2,
      },
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/checkout/buy/session/chk_offer");
  });

  it("starts signed-out cart checkout by creating a guest account and merging the anonymous cart", async () => {
    resolveGuestFromCookie();
    mockStartGuestCheckout.mockResolvedValue(guestStart());
    mockCreateAuthRequestApiClient.mockReturnValue({
      startGuestCheckout: mockStartGuestCheckout,
    });
    mockCreateCheckoutSession.mockResolvedValue({ session_id: "chk_guest" });
    mockMergeGuestCartToAccount.mockResolvedValue({ mergedLineCount: 0, failedLineCount: 0 });
    mockGetGuestCart.mockResolvedValue({ items: [], count: 1 });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getGuestCart: mockGetGuestCart,
      createCartReadiness: mockCreateCartReadiness,
      createCheckoutSession: mockCreateCheckoutSession,
      mergeGuestCartToAccount: mockMergeGuestCartToAccount,
    });

    const form = new URLSearchParams();
    form.set("source", "cart");
    const anonymousCart = "chase_sets_anonymous_cart=anon_cart_1";

    const hop = await postStart("http://localhost/checkout/buy/readiness", form, anonymousCart);

    // The hop carries only the guest cookie; the anonymous cart stays for the followed POST to merge.
    expect(setCookiePairs(hop)).toEqual(["chase_sets_guest_checkout=guest_token"]);
    expect(mockMergeGuestCartToAccount).not.toHaveBeenCalled();

    const response = await followGuestEntry(hop, form, anonymousCart);

    expect(mockStartGuestCheckout).toHaveBeenCalledWith({});
    expect(mockMergeGuestCartToAccount).toHaveBeenCalledWith("anon_cart_1");
    expect(mockCreateCartReadiness).toHaveBeenCalledWith({});
    expect(mockCreateCheckoutSession).toHaveBeenCalledWith({
      source: {
        type: "cart",
        readinessSnapshotId: "cr_ready",
        readinessSourceRevision: "cr_source",
        readinessDecisions: null,
      },
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/checkout/buy/session/chk_guest");
    expect(response.headers.get("X-Remix-Reload-Document")).toBe("true");
    expect(setCookiePairs(response)).toEqual(["chase_sets_anonymous_cart="]);
  });

  it("uses one anonymous-source client per request for guest merge, readiness, and session without polling", async () => {
    resolveGuestFromCookie();
    mockStartGuestCheckout.mockResolvedValue(guestStart());
    mockCreateAuthRequestApiClient.mockReturnValue({
      startGuestCheckout: mockStartGuestCheckout,
    });
    mockMergeGuestCartToAccount.mockResolvedValue({
      mergedLineCount: 1,
      commitPositions: [
        {
          sourceContextName: "checkout",
          maxGlobalPosition: "42",
          eventIds: ["evt_guest_cart_merged"],
        },
      ],
    });
    mockCreateCheckoutSession.mockResolvedValue({
      session_id: "chk_guest",
      commitPositions: [
        {
          sourceContextName: "checkout",
          maxGlobalPosition: "43",
          eventIds: ["evt_checkout_session_started"],
        },
      ],
    });
    mockGetGuestCart.mockResolvedValue({ items: [], count: 1 });
    const mutableApiClientCalls: { request: Request; options: unknown }[] = [];
    mockCreateCheckoutRequestApiClient.mockImplementation((request: Request, options?: unknown) => {
      mutableApiClientCalls.push({ request, options });
      return {
        getGuestCart: mockGetGuestCart,
        createCartReadiness: mockCreateCartReadiness,
        createCheckoutSession: mockCreateCheckoutSession,
        mergeGuestCartToAccount: mockMergeGuestCartToAccount,
      };
    });

    const form = new URLSearchParams();
    form.set("source", "cart");
    const anonymousCart = "chase_sets_anonymous_cart=anon_cart_1";

    const hop = await postStart("http://localhost/checkout/buy/readiness", form, anonymousCart);
    const response = await followGuestEntry(hop, form, anonymousCart);
    const redirectReceipt = await readRedirectFreshWriteToken(response.headers.get("Location"));

    expect(mockMergeGuestCartToAccount).toHaveBeenCalledWith("anon_cart_1");
    expect(mockGetCart).not.toHaveBeenCalled();
    expect(mutableApiClientCalls).toHaveLength(2);
    for (const call of mutableApiClientCalls) {
      expect(call.options).toEqual({ headers: { "x-checkout-anonymous-cart-id": "anon_cart_1" } });
    }
    // The Session-writing client presents the guest cookie on the request itself.
    expect(mutableApiClientCalls[0]?.request.headers.get("cookie")).toBe(anonymousCart);
    expect(mutableApiClientCalls[1]?.request.headers.get("cookie")).toBe(
      `${anonymousCart}; chase_sets_guest_checkout=guest_token`,
    );
    expect(mockCreateCartReadiness).toHaveBeenCalledWith({});
    expect(mockCreateCheckoutSession).toHaveBeenCalledWith({
      source: {
        type: "cart",
        readinessSnapshotId: "cr_ready",
        readinessSourceRevision: "cr_source",
        readinessDecisions: null,
      },
    });
    expect(redirectReceipt).toMatchObject({
      sources: [
        {
          sourceContextName: "checkout",
          maxGlobalPosition: "43",
          eventIds: ["evt_guest_cart_merged", "evt_checkout_session_started"],
        },
      ],
    });
  });

  it("continues guest cart entry from the union when the best-effort merge throws", async () => {
    resolveGuestFromCookie();
    mockStartGuestCheckout.mockResolvedValue(guestStart());
    mockCreateAuthRequestApiClient.mockReturnValue({ startGuestCheckout: mockStartGuestCheckout });
    mockGetGuestCart.mockResolvedValue({ items: [], count: 1 });
    mockMergeGuestCartToAccount.mockRejectedValue(new Error("anon_raw_merge_marker secret"));
    mockCreateCheckoutSession.mockResolvedValue(checkoutSessionResult("chk_guest_union", "43"));
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getGuestCart: mockGetGuestCart,
      createCartReadiness: mockCreateCartReadiness,
      createCheckoutSession: mockCreateCheckoutSession,
      mergeGuestCartToAccount: mockMergeGuestCartToAccount,
    });

    const form = new URLSearchParams({ source: "cart" });
    const anonymousCart = "chase_sets_anonymous_cart=anon_cart_1";
    const hop = await postStart("http://localhost/checkout/buy/readiness", form, anonymousCart);
    const response = await followGuestEntry(hop, form, anonymousCart);

    expect(mockMergeGuestCartToAccount).toHaveBeenCalledOnce();
    expect(mockGetCart).not.toHaveBeenCalled();
    expect(mockCreateCartReadiness).toHaveBeenCalledWith({});
    expect(mockCreateCheckoutSession).toHaveBeenCalledOnce();
    expect(response.headers.get("Location")).toContain("/checkout/buy/session/chk_guest_union");
    expect(response.headers.getSetCookie().join("; ")).toContain("chase_sets_anonymous_cart=");
  });

  it("marks guest checkout and cleared anonymous cart cookies secure on HTTPS handoff", async () => {
    resolveGuestFromCookie();
    mockStartGuestCheckout.mockResolvedValue(guestStart());
    mockCreateAuthRequestApiClient.mockReturnValue({
      startGuestCheckout: mockStartGuestCheckout,
    });
    mockCreateCheckoutSession.mockResolvedValue({ session_id: "chk_guest" });
    mockMergeGuestCartToAccount.mockResolvedValue({ status: "merged" });
    mockGetGuestCart.mockResolvedValue({ items: [], count: 1 });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getGuestCart: mockGetGuestCart,
      createCartReadiness: mockCreateCartReadiness,
      createCheckoutSession: mockCreateCheckoutSession,
      mergeGuestCartToAccount: mockMergeGuestCartToAccount,
    });

    const form = new URLSearchParams();
    form.set("source", "cart");

    const anonymousCart = "chase_sets_anonymous_cart=anon_cart_1";
    const origin = "https://staging.chasesets.com";
    const hop = await postStart(`${origin}/checkout/buy/readiness`, form, anonymousCart);
    const response = await followGuestEntry(hop, form, anonymousCart, origin);

    expect(hop.headers.getSetCookie().find((cookie) => cookie.startsWith("chase_sets_guest_checkout="))).toContain(
      "Secure",
    );
    expect(response.headers.getSetCookie().find((cookie) => cookie.startsWith("chase_sets_anonymous_cart="))).toContain(
      "Secure",
    );
  });

  it("does not start payment while starting signed-out guest cart checkout", async () => {
    resolveGuestFromCookie();
    mockStartGuestCheckout.mockResolvedValue(guestStart());
    mockCreateAuthRequestApiClient.mockReturnValue({
      startGuestCheckout: mockStartGuestCheckout,
    });
    mockCreateCheckoutSession.mockResolvedValue({ session_id: "chk_guest" });
    mockMergeGuestCartToAccount.mockResolvedValue({ status: "merged" });
    mockGetGuestCart.mockResolvedValue({ items: [], count: 1 });
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      getGuestCart: mockGetGuestCart,
      createCartReadiness: mockCreateCartReadiness,
      createCheckoutSession: mockCreateCheckoutSession,
      mergeGuestCartToAccount: mockMergeGuestCartToAccount,
    });
    mockCreatePaymentsRequestApiClient.mockReturnValue({
      createCheckoutPayment: vi.fn(),
      previewCheckoutStatus: mockPreviewCheckoutStatus,
    });

    const form = new URLSearchParams();
    form.set("source", "cart");
    const anonymousCart = "chase_sets_anonymous_cart=anon_cart_1";

    const hop = await postStart("http://localhost/checkout/buy/readiness", form, anonymousCart);
    await followGuestEntry(hop, form, anonymousCart);

    expect(mockCreateCheckoutSession).toHaveBeenCalledOnce();
    expect(mockCreatePaymentsRequestApiClient).not.toHaveBeenCalled();
    expect(mockConfirmCheckoutSession).not.toHaveBeenCalled();
  });

  it("requires registration or sign-in before starting purchase-intent checkout", async () => {
    mockResolveActorFromAuthApi.mockResolvedValue(null);
    mockCreateCheckoutRequestApiClient.mockReturnValue({
      createCheckoutSession: mockCreateCheckoutSession,
    });

    const form = new URLSearchParams();
    form.set("source", "offer-intent");

    const result = await checkoutStartAction({
      request: new Request("http://localhost/checkout/buy/readiness?source=offer-intent", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: {},
      context: undefined,
    } as never);

    expect(result).toEqual({
      error: "Register or sign in to submit an offer.",
      signInPath: "/sign-in?returnTo=%2Fcheckout%2Fbuy%2Freadiness%3Fsource%3Doffer-intent",
    });
    expect(mockStartGuestCheckout).not.toHaveBeenCalled();
    expect(mockCreateCheckoutSession).not.toHaveBeenCalled();
  });

  it("uses purchase-intent account copy instead of guest checkout copy", () => {
    expect(checkoutStartHeaderCopy({ isSignedIn: false, isOfferIntent: true })).toEqual({
      title: "Register to submit an offer",
      description: "Register or sign in to submit your offer. Sellers review it before any payment is collected.",
    });
    expect(checkoutStartHeaderCopy({ isSignedIn: true, isOfferIntent: true })).toEqual({
      title: "Submit offer",
      description: "Confirm shipping so sellers can review your offer. No payment today.",
    });
    expect(
      checkoutStartBuyerProtectionItems(true)
        .map((item) => item.description)
        .join(" "),
    ).not.toContain("Guest");
  });

  describe("guest entry binds before write", () => {
    it("opens the Session as the minted guest only on the followed POST, and replays it when that response is lost", async () => {
      const world = guestEntryWorld();
      const form = buyNowEntryForm();

      const hop = await world.post(buyNowStartUrl, form);

      expect(hop.status).toBe(307);
      expect(hop.headers.get("X-Remix-Reload-Document")).toBeNull();
      expect(hop.headers.get("Location")).toBe(`${buyNowStartUrl.replace("http://localhost", "")}&guestEntry=1`);
      expect(setCookiePairs(hop)).toEqual(["chase_sets_guest_checkout=guest_token_1"]);
      expect(world.checkoutCalls).toEqual([]);

      // The followed POST presents the cookie and opens the Session; its response never arrives.
      const followed = new URL(hop.headers.get("Location") ?? "", "http://localhost").toString();
      const lost = await world.post(followed, form, { delivered: false });
      expect(lost.status).toBe(302);
      expect(lost.headers.get("X-Remix-Reload-Document")).toBe("true");

      // The browser already holds the cookie, so a re-click and a POST resubmit both replay the first Session.
      const reclicked = await world.post(buyNowStartUrl, form);
      const resubmitted = await world.post(followed, form);

      for (const answer of [lost, reclicked, resubmitted]) {
        expect(new URL(answer.headers.get("Location") ?? "", "http://localhost").pathname).toBe(
          "/checkout/buy/session/chk_guest_entry_1",
        );
      }
      expect(mockStartGuestCheckout).toHaveBeenCalledOnce();
      expect([...world.guests.keys()]).toEqual(["guest_token_1"]);
      // One entry attempt per account and key: the owner recorded exactly one and opened no second Session.
      expect(world.sessions).toEqual([
        {
          sessionId: "chk_guest_entry_1",
          accountId: "acc_guest_1",
          entryAttemptKey: "chkentry_01JGUESTENTRYBINDS0001",
        },
      ]);
    });

    it("leaves one Session, owned by the second guest, when the 307 itself is lost", async () => {
      const world = guestEntryWorld();
      const form = buyNowEntryForm();

      const lostHop = await world.post(buyNowStartUrl, form, { delivered: false });
      expect(lostHop.status).toBe(307);
      expect(world.jar.size).toBe(0);

      const hop = await world.post(buyNowStartUrl, form);
      const opened = await world.post(hop.headers.get("Location") ?? "", form);

      expect(new URL(opened.headers.get("Location") ?? "", "http://localhost").pathname).toBe(
        "/checkout/buy/session/chk_guest_entry_1",
      );
      expect(mockStartGuestCheckout).toHaveBeenCalledTimes(2);
      expect(world.sessions).toHaveLength(1);
      expect(world.ownedSessions("acc_guest_2")).toHaveLength(1);
      expect(world.ownedSessions("acc_guest_1")).toEqual([]);
    });

    it("mints nothing and shows guest-access-expired when the browser refuses the guest cookie", async () => {
      const world = guestEntryWorld({ refuseCookies: true });
      const form = buyNowEntryForm();

      const hop = await world.post(buyNowStartUrl, form);
      const result = await world.post(hop.headers.get("Location") ?? "", form);

      expect(result).toEqual({
        recovery: expect.objectContaining({
          kind: "guest-access-expired",
          status: 401,
          trustCue: "Your payment has not started.",
        }),
      });
      expect(mockStartGuestCheckout).toHaveBeenCalledOnce();
      expect(world.checkoutCalls).toEqual([]);
      expect(world.sessions).toEqual([]);
    });

    it("mints nothing and shows guest-access-expired when the guest cookie expired before the followed POST", async () => {
      const world = guestEntryWorld();
      const form = buyNowEntryForm();

      const hop = await world.post(buyNowStartUrl, form);
      world.expireGuest("guest_token_1");
      const result = await world.post(hop.headers.get("Location") ?? "", form);

      expect(result).toEqual({
        recovery: expect.objectContaining({ kind: "guest-access-expired", status: 401 }),
      });
      expect(mockStartGuestCheckout).toHaveBeenCalledOnce();
      expect(world.checkoutCalls).toEqual([]);
      expect(world.sessions).toEqual([]);
    });

    it("answers anonymous-cart entry with the 307 and no Session write, then opens the Session as the new guest", async () => {
      const world = guestEntryWorld();
      world.jar.set("chase_sets_anonymous_cart", "anon_cart_1");
      const form = new URLSearchParams({ source: "cart" });

      const hop = await world.post("http://localhost/checkout/buy/readiness", form);

      expect(hop.status).toBe(307);
      expect(setCookiePairs(hop)).toEqual(["chase_sets_guest_checkout=guest_token_1"]);
      expect(world.checkoutCalls).toEqual(["getGuestCart"]);
      expect(world.sessions).toEqual([]);

      const opened = await world.post(hop.headers.get("Location") ?? "", form);

      expect(opened.headers.get("X-Remix-Reload-Document")).toBe("true");
      expect(world.checkoutCalls).toEqual([
        "getGuestCart",
        "mergeGuestCartToAccount",
        "createCartReadiness",
        "createCheckoutSession",
      ]);
      expect(world.ownedSessions("acc_guest_1")).toHaveLength(1);
      expect(world.jar.has("chase_sets_anonymous_cart")).toBe(false);
    });

    it("answers the 403 mismatch recovery with the 307 and no Session write, then opens the Session as the new guest", async () => {
      const world = guestEntryWorld();
      const form = buyNowEntryForm();
      // A returning guest holds a cookie whose access no longer matches the Session it starts.
      await world.post(buyNowStartUrl, form);
      world.refuseGuest("guest_token_1");
      const callsBefore = world.checkoutCalls.length;

      const hop = await world.post(buyNowStartUrl, form);

      expect(hop.status).toBe(307);
      expect(setCookiePairs(hop)).toEqual(["chase_sets_guest_checkout=guest_token_2"]);
      expect(world.checkoutCalls.slice(callsBefore)).toEqual(["createCheckoutSession"]);
      expect(world.sessions).toEqual([]);

      const opened = await world.post(hop.headers.get("Location") ?? "", form);

      expect(opened.headers.get("X-Remix-Reload-Document")).toBe("true");
      expect(mockStartGuestCheckout).toHaveBeenCalledTimes(2);
      expect(world.sessions).toEqual([
        {
          sessionId: "chk_guest_entry_1",
          accountId: "acc_guest_2",
          entryAttemptKey: "chkentry_01JGUESTENTRYBINDS0001",
        },
      ]);
    });
  });

  describe("guest entry through the data router", () => {
    /** The window a data router reads to tell a document redirect from a client-side one. */
    function browserWindow() {
      return {
        document: { createElement: () => ({}) },
        location: { origin: "http://localhost", assign: vi.fn(), replace: vi.fn() },
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
    }

    async function settled(router: ReturnType<typeof createMemoryRouter>) {
      await vi.waitFor(() => {
        expect(router.state.initialized).toBe(true);
        expect(router.state.navigation.state).toBe("idle");
      });
    }

    it("re-submits the guest entry 307 with its method and body and reaches the Session with the guest cookie and afterWrite receipt", async () => {
      const world = guestEntryWorld();
      const browser = browserWindow();
      vi.stubGlobal("window", browser);
      const posts: Array<{ url: string; method: string; body: string; cookie: string }> = [];
      const sessionLoads: Array<{ url: string; cookie: string }> = [];
      /** The network between router and server: each request presents the jar, each response fills it. */
      const send = async (request: Request) => {
        const headers = new Headers(request.headers);
        if (world.cookieHeader()) headers.set("cookie", world.cookieHeader());
        const body = request.method === "GET" ? undefined : await request.text();
        return new Request(request.url, { method: request.method, headers, body, signal: request.signal });
      };
      const routes = [
        {
          id: "checkout-start",
          path: "/checkout/buy/readiness",
          loader: async (args: LoaderFunctionArgs) =>
            checkoutStartLoader({ ...args, request: await send(args.request) }),
          action: async (args: ActionFunctionArgs) => {
            const request = await send(args.request);
            posts.push({
              url: request.url,
              method: request.method,
              body: await request.clone().text(),
              cookie: request.headers.get("cookie") ?? "",
            });
            const result = await checkoutStartAction({ ...args, request });
            return result instanceof Response ? world.receive(result) : result;
          },
        },
        {
          id: "checkout-session",
          path: "/checkout/buy/session/:sessionId",
          loader: async (args: LoaderFunctionArgs) => {
            const request = await send(args.request);
            sessionLoads.push({ url: request.url, cookie: request.headers.get("cookie") ?? "" });
            return null;
          },
        },
      ];
      const startPath = buyNowStartUrl.replace("http://localhost", "");
      const formData = new FormData();
      formData.set("entryAttemptKey", "chkentry_01JGUESTENTRYROUTER001");
      formData.set("source", "buy-now");
      const sentBody = "entryAttemptKey=chkentry_01JGUESTENTRYROUTER001&source=buy-now";

      try {
        const router = createMemoryRouter(routes, { initialEntries: [startPath] });
        await settled(router);
        await router.navigate(startPath, { formMethod: "post", formData });

        // The router re-sends the 307 with the same method and body, now presenting the guest cookie.
        expect(posts).toEqual([
          { url: buyNowStartUrl, method: "POST", body: sentBody, cookie: "" },
          {
            url: `${buyNowStartUrl}&guestEntry=1`,
            method: "POST",
            body: sentBody,
            cookie: "chase_sets_guest_checkout=guest_token_1",
          },
        ]);
        // The Session answer is the guest document redirect, so the browser loads it as a new document.
        expect(browser.location.assign).toHaveBeenCalledOnce();
        const documentPath = String(browser.location.assign.mock.calls[0]?.[0]);
        router.dispose();
        const sessionDocument = createMemoryRouter(routes, { initialEntries: [documentPath] });
        await settled(sessionDocument);
        sessionDocument.dispose();

        expect(new URL(documentPath, "http://localhost").pathname).toBe("/checkout/buy/session/chk_guest_entry_1");
        expect(sessionLoads).toEqual([
          {
            url: new URL(documentPath, "http://localhost").toString(),
            cookie: "chase_sets_guest_checkout=guest_token_1",
          },
        ]);
        expect(await readRedirectFreshWriteToken(documentPath)).toMatchObject({
          sources: [{ sourceContextName: "checkout", maxGlobalPosition: "42", eventIds: ["evt_chk_guest_entry_1"] }],
        });
        expect(mockStartGuestCheckout).toHaveBeenCalledOnce();
        expect(world.sessions).toEqual([
          {
            sessionId: "chk_guest_entry_1",
            accountId: "acc_guest_1",
            entryAttemptKey: "chkentry_01JGUESTENTRYROUTER001",
          },
        ]);
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });
});
