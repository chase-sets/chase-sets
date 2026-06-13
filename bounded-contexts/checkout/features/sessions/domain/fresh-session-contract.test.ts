import { describe, expect, it } from "vitest";

import {
  canTransitionFreshCheckout,
  canConfirmFreshCheckout,
  findCheckoutCustomerCopyLeaks,
  findSensitiveCheckoutSnapshotKeys,
  freshCheckoutCommandTypes,
  hasForbiddenFreshCheckoutCommand,
  isFreshCheckoutCommandType,
  renderableCheckoutSummary,
  requiresPreCheckoutResolution,
  type CheckoutMoney,
  type FreshBuyCheckoutSessionSnapshot,
  type FreshCheckoutSessionSnapshot,
  type FreshSellCheckoutSessionSnapshot,
} from "./fresh-session-contract";

const usd = (amount: string): CheckoutMoney => ({ amount, currency: "USD" });

const commonLine = {
  lineId: "line_1",
  itemTitle: "Acerola's Mischief",
  itemSubtitle: "Raw / Damaged",
  thumbnailUrl: "https://images.test/acerola.jpg",
  quantity: 1,
  unitAmount: usd("25.99"),
  lineAmount: usd("25.99"),
  fulfillmentStatus: "ready" as const,
  customerFacts: ["Ships Jun 16-19"],
};

const commonSnapshot = {
  schemaVersion: "checkout.fresh-session.v1" as const,
  sessionId: "chk_01" as never,
  creationIdempotencyKey: "cart_1:fulfillment-rev-1",
  actorMode: "guest" as const,
  accountId: null,
  guestMerge: {
    eligible: true,
    mergeToken: "guest_merge_1",
    signedInAccountId: null,
  },
  lifecycleStatus: "ready" as const,
  source: {
    type: "cart" as const,
    sourceId: "cart_1",
    returnPath: "/account/cart",
  },
  lines: [commonLine],
  contact: {
    status: "valid" as const,
    email: "buyer@example.test",
    phone: null,
    displayName: "Jane Smith",
  },
  deliveryAddress: {
    status: "valid" as const,
    label: "Home",
    summary: "100 Market Street, Chicago IL",
    correctionAvailable: false,
    serviceability: "serviceable" as const,
  },
  shipFromAddress: null,
  shipping: {
    status: "valid" as const,
    selectedMethodId: "standard",
    label: "Standard",
    amount: usd("4.00"),
    promise: "4-7 business days",
  },
  readiness: {
    status: "ready" as const,
    unresolvedLineIds: [],
    optimization: {
      available: false,
      savings: null,
      accepted: null,
    },
    recoveryPath: null,
  },
  freshness: {
    status: "current" as const,
    reason: null,
    revision: "fulfillment-rev-1",
    recoverCommand: null,
  },
  provider: {
    status: "ready" as const,
    correlationId: "provider-correlation-1",
    retryAvailable: false,
    customerSafeMessage: null,
  },
  risk: {
    status: "clear" as const,
    customerSafeReason: null,
    recoveryPath: null,
  },
  recovery: null,
  communication: {
    notificationStatus: "not-started" as const,
    retryAvailable: false,
  },
  reconciliation: {
    status: "not-started" as const,
    pendingFacts: [],
    retryAvailable: false,
  },
  splitGroupHandoff: {
    status: "ready" as const,
    supportReference: "CS-CR_READY",
    groups: [
      {
        groupId: "cfg_card_vault",
        lineIds: ["line_1"],
        listingIds: ["lst_1"],
        sellerAccountId: "acc_seller" as never,
        sellerDisplayName: "Card Vault",
        packageCount: 1,
        itemCount: 1,
        deliveryPromise: "4-7 business days",
        shippingAmount: usd("4.00"),
        supportReference: "CSG-CARDVAULT",
        downstreamReferenceStatus: "not-started" as const,
        orderIds: [],
        shipmentIds: [],
      },
    ],
  },
  postConfirmation: {
    status: "not-started" as const,
    orderIds: [],
    saleIds: [],
    shipmentIds: [],
    paymentId: null,
    payoutId: null,
    accountHistoryHref: null,
  },
  savedInfoRows: [],
  availableCommands: ["confirm", "return-to-source-list"] as const,
};

const buySnapshot: FreshBuyCheckoutSessionSnapshot = {
  ...commonSnapshot,
  mode: "buy",
  payment: {
    status: "valid",
    selectedMethodId: "pm_card",
    displayLabel: "Card ending in 4242",
    providerStatus: "ready",
    savedForFuture: false,
  },
  payout: null,
  totals: {
    subtotal: usd("25.99"),
    shipping: usd("4.00"),
    tax: usd("0.00"),
    fees: [usd("1.10")],
    discounts: [],
    credits: [],
    payableTotal: usd("31.09"),
  },
};

const sellSnapshot: FreshSellCheckoutSessionSnapshot = {
  ...commonSnapshot,
  mode: "sell",
  actorMode: "signed-in",
  accountId: "acc_seller" as never,
  source: {
    type: "sell-list",
    sourceId: "sell_list_1",
    returnPath: "/account/sell-list",
  },
  splitGroupHandoff: null,
  deliveryAddress: null,
  shipFromAddress: {
    status: "valid",
    label: "Ship from",
    summary: "3354 Brush Creek Court, Wichita KS",
    correctionAvailable: false,
    serviceability: "serviceable",
  },
  shipping: {
    status: "valid",
    selectedMethodId: "prepaid-label",
    label: "Prepaid label",
    amount: usd("0.00"),
    promise: "Print after confirmation",
  },
  payment: null,
  payout: {
    status: "valid",
    selectedMethodId: "payout_default",
    displayLabel: "Payout account ready",
    providerStatus: "ready",
    readinessStatus: "ready",
  },
  totals: {
    estimatedPayout: usd("20.00"),
    labelOrShippingAllowance: usd("0.00"),
    fees: [usd("1.00")],
    adjustments: [],
    payoutTotal: usd("19.00"),
    verificationTermsAccepted: true,
  },
};

describe("fresh checkout session contract", () => {
  it("renders buy and sell sessions from one summary shape", () => {
    expect(renderableCheckoutSummary(buySnapshot)).toEqual({
      schemaVersion: "checkout.fresh-session.v1",
      sessionId: "chk_01",
      mode: "buy",
      actorMode: "guest",
      lifecycleStatus: "ready",
      lineCount: 1,
      total: usd("31.09"),
      readinessStatus: "ready",
      freshnessStatus: "current",
      providerStatus: "ready",
      riskStatus: "clear",
      splitGroupCount: 1,
      postConfirmationStatus: "not-started",
      primaryAction: "confirm",
    });

    expect(renderableCheckoutSummary(sellSnapshot)).toMatchObject({
      mode: "sell",
      actorMode: "signed-in",
      total: usd("19.00"),
      primaryAction: "confirm",
    });
  });

  it("keeps split group handoff as summary facts before downstream records exist", () => {
    expect(buySnapshot.splitGroupHandoff).toMatchObject({
      status: "ready",
      supportReference: "CS-CR_READY",
      groups: [
        {
          lineIds: ["line_1"],
          listingIds: ["lst_1"],
          downstreamReferenceStatus: "not-started",
          orderIds: [],
          shipmentIds: [],
        },
      ],
    });
    expect(findCheckoutCustomerCopyLeaks(buySnapshot)).toEqual([]);
  });

  it("keeps unresolved fulfillment in readiness instead of confirmable checkout", () => {
    const unresolved: FreshCheckoutSessionSnapshot = {
      ...buySnapshot,
      readiness: {
        ...buySnapshot.readiness,
        status: "needs-resolution",
        unresolvedLineIds: ["line_1"],
        recoveryPath: "/checkout/buy/readiness",
      },
    };

    expect(requiresPreCheckoutResolution(unresolved)).toBe(true);
    expect(canConfirmFreshCheckout(unresolved)).toBe(false);
    expect(renderableCheckoutSummary(unresolved).primaryAction).toBe("resolve");
  });

  it("blocks stale, provider-failed, seller-readiness, and risk-held sessions from confirmation", () => {
    expect(
      canConfirmFreshCheckout({
        ...buySnapshot,
        freshness: {
          status: "stale",
          reason: "fulfillment-changed",
          revision: "old",
          recoverCommand: "recover-stale-session",
        },
        recovery: {
          reason: "stale-session",
          command: "recover-stale-session",
          returnPath: "/account/cart",
          customerSafeMessage: "Review updated shipping and totals before paying.",
        },
      }),
    ).toBe(false);

    expect(
      canConfirmFreshCheckout({
        ...buySnapshot,
        provider: {
          status: "failed",
          correlationId: "provider-correlation-2",
          retryAvailable: true,
          customerSafeMessage: "Payment provider is unavailable.",
        },
      }),
    ).toBe(false);

    expect(
      canConfirmFreshCheckout({
        ...sellSnapshot,
        payout: {
          ...sellSnapshot.payout,
          readinessStatus: "blocked",
        },
      }),
    ).toBe(false);

    expect(
      canConfirmFreshCheckout({
        ...sellSnapshot,
        risk: {
          status: "held",
          customerSafeReason: "Manual review is required.",
          recoveryPath: "/account/sell-list",
        },
      }),
    ).toBe(false);
  });

  it("names every fresh command and excludes old-session commands", () => {
    expect(freshCheckoutCommandTypes).toEqual([
      "update-contact",
      "update-address",
      "select-shipping-method",
      "select-payment-method",
      "select-payout-method",
      "apply-credit-or-promotion",
      "remove-credit-or-promotion",
      "refresh-totals",
      "confirm",
      "recover-stale-session",
      "recover-provider-failure",
      "recover-partial-completion",
      "merge-guest-session",
      "return-to-source-list",
    ]);

    expect(isFreshCheckoutCommandType("confirm")).toBe(true);
    expect(isFreshCheckoutCommandType("adapt-old-checkout-payload")).toBe(false);
    expect(hasForbiddenFreshCheckoutCommand(freshCheckoutCommandTypes)).toBe(false);
    expect(hasForbiddenFreshCheckoutCommand(["confirm", "dual-write-old-session"])).toBe(true);
  });

  it("defines lifecycle transitions for the fresh state machine", () => {
    expect(canTransitionFreshCheckout("draft", "ready")).toBe(true);
    expect(canTransitionFreshCheckout("ready", "confirming")).toBe(true);
    expect(canTransitionFreshCheckout("confirming", "confirmed")).toBe(true);
    expect(canTransitionFreshCheckout("confirmed", "ready")).toBe(false);
  });

  it("keeps creation idempotent and guest merge explicit", () => {
    expect(buySnapshot.creationIdempotencyKey).toBe("cart_1:fulfillment-rev-1");
    expect(buySnapshot.guestMerge).toEqual({
      eligible: true,
      mergeToken: "guest_merge_1",
      signedInAccountId: null,
    });
    expect(isFreshCheckoutCommandType("merge-guest-session")).toBe(true);
  });

  it("treats invalid addresses, changed economics, and deploy skew as recoverable fresh-state issues", () => {
    const invalidAddress: FreshCheckoutSessionSnapshot = {
      ...buySnapshot,
      deliveryAddress: {
        status: "invalid",
        label: "Home",
        summary: "100 Market Street, Chicago IL",
        correctionAvailable: true,
        serviceability: "unknown",
      },
      recovery: {
        reason: "invalid-address",
        command: "update-address",
        returnPath: "/checkout/buy/session/chk_01",
        customerSafeMessage: "Confirm the shipping address before paying.",
      },
    };

    const changedEconomics: FreshCheckoutSessionSnapshot = {
      ...buySnapshot,
      freshness: {
        status: "stale",
        reason: "fees-changed",
        revision: "fees-rev-2",
        recoverCommand: "refresh-totals",
      },
      recovery: {
        reason: "stale-session",
        command: "refresh-totals",
        returnPath: "/checkout/buy/session/chk_01",
        customerSafeMessage: "Review updated fees and totals before paying.",
      },
    };

    const deploySkew: FreshCheckoutSessionSnapshot = {
      ...buySnapshot,
      freshness: {
        status: "stale",
        reason: "provider-skew",
        revision: "provider-rev-3",
        recoverCommand: "recover-provider-failure",
      },
      recovery: {
        reason: "provider-failure",
        command: "recover-provider-failure",
        returnPath: "/checkout/buy/session/chk_01",
        customerSafeMessage: "Refresh checkout before paying.",
      },
    };

    expect(canConfirmFreshCheckout(invalidAddress)).toBe(false);
    expect(canConfirmFreshCheckout(changedEconomics)).toBe(false);
    expect(canConfirmFreshCheckout(deploySkew)).toBe(false);
    expect(changedEconomics.freshness.reason).toBe("fees-changed");
  });

  it("models missing partial data and partial-completion recovery without old payloads", () => {
    const missingContact: FreshCheckoutSessionSnapshot = {
      ...buySnapshot,
      contact: {
        status: "missing",
        email: null,
        phone: null,
        displayName: null,
      },
      availableCommands: ["update-contact", "return-to-source-list"],
    };

    const partialCompletion: FreshCheckoutSessionSnapshot = {
      ...buySnapshot,
      lifecycleStatus: "recovering",
      recovery: {
        reason: "partial-completion",
        command: "recover-partial-completion",
        returnPath: "/checkout/buy/session/chk_01",
        customerSafeMessage: "We are finishing confirmation. Refresh for the latest status.",
      },
      reconciliation: {
        status: "pending",
        pendingFacts: ["order-confirmation"],
        retryAvailable: true,
      },
      postConfirmation: {
        ...buySnapshot.postConfirmation,
        status: "pending",
      },
    };

    expect(canConfirmFreshCheckout(missingContact)).toBe(false);
    expect(canConfirmFreshCheckout(partialCompletion)).toBe(false);
    expect(partialCompletion.recovery?.command).toBe("recover-partial-completion");
    expect(hasForbiddenFreshCheckoutCommand(partialCompletion.availableCommands)).toBe(false);
  });

  it("flags internal terms before customer checkout copy is rendered", () => {
    expect(findCheckoutCustomerCopyLeaks(buySnapshot)).toEqual([]);
    expect(
      findCheckoutCustomerCopyLeaks({
        ...buySnapshot,
        provider: {
          ...buySnapshot.provider,
          customerSafeMessage: "Provider payload failed internal allocation.",
        },
      }),
    ).toEqual(["Provider payload failed internal allocation."]);
  });

  it("carries notification, reconciliation, and post-confirmation state without side effects", () => {
    const confirmed: FreshCheckoutSessionSnapshot = {
      ...buySnapshot,
      lifecycleStatus: "confirmed",
      communication: {
        notificationStatus: "queued",
        retryAvailable: false,
      },
      reconciliation: {
        status: "pending",
        pendingFacts: ["payment-webhook"],
        retryAvailable: true,
      },
      postConfirmation: {
        status: "pending",
        orderIds: ["ord_1" as never],
        saleIds: [],
        shipmentIds: [],
        paymentId: "pay_1" as never,
        payoutId: null,
        accountHistoryHref: "/account/purchases/ord_1",
      },
    };

    expect(renderableCheckoutSummary(confirmed)).toMatchObject({
      lifecycleStatus: "confirmed",
      postConfirmationStatus: "pending",
    });
    expect(confirmed.reconciliation.pendingFacts).toEqual(["payment-webhook"]);
  });

  it("keeps sensitive provider, payment, payout, and identity fields out of snapshots", () => {
    expect(findSensitiveCheckoutSnapshotKeys(buySnapshot)).toEqual([]);
    expect(
      findSensitiveCheckoutSnapshotKeys({
        ...buySnapshot,
        payment: {
          ...buySnapshot.payment,
          cardNumber: "4242424242424242",
        },
        rawProviderPayload: {
          clientSecret: "secret",
        },
        identityPayload: {
          verificationDocument: "document-bytes",
        },
      }),
    ).toEqual([
      "snapshot.payment.cardNumber",
      "snapshot.rawProviderPayload",
      "snapshot.rawProviderPayload.clientSecret",
      "snapshot.identityPayload",
      "snapshot.identityPayload.verificationDocument",
    ]);
  });
});
