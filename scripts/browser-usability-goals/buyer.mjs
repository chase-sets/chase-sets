export default {
  id: "buyer",
  routeScope: [
    "^bounded-contexts/checkout/routes/(account-cart|checkout-session|checkout-start|buy-checkout-confirmation)\\.tsx$",
    "^bounded-contexts/payments/routes/marketplace/",
    "^bounded-contexts/ordering/routes/account-purchases?\\.tsx$",
    "^bounded-contexts/fulfillment/routes/marketplace/account-shipments?\\.tsx$",
    "^bounded-contexts/marketplace/routes/account-offers?-",
    "^bounded-contexts/marketplace/routes/marketplace/(account-purchase-review|account-review|account-written-reviews|account-review-summary)\\.tsx$",
    "^bounded-contexts/discovery/routes/account-product-alerts\\.tsx$",
    "^bounded-contexts/notifications/routes/account-notifications\\.tsx$",
    "^bounded-contexts/identity/routes/marketplace/(account|account-security|account-consents|account-shipping-addresses)\\.tsx$",
    "^bounded-contexts/auth/routes/marketplace/account-",
    "^bounded-contexts/platform-operations/routes/marketplace/",
  ],
  goals: [
    {
      id: "find-card",
      version: 1,
      startPath: "/",
      role: "buyer",
      host: "marketplace",
      goal: "Find an English Base Set Charizard, raw and Near Mint. Determine whether you can buy that variant now and at what price. Do not add it to a cart or buy it. Report unavailable information rather than guessing.",
      checks: ["variant", "availability-and-price"],
      oracle: {
        variant: "Reobserve the actual variant against authoritative fixture data.",
        "availability-and-price": "Reobserve the actual availability and price against authoritative fixture data.",
      },
      routes: {},
      paths: ["bounded-contexts/discovery/", "bounded-contexts/catalog/"],
      selectOnSharedChange: true,
    },
    {
      id: "buyer-shipment",
      version: 1,
      startPath: "/account",
      role: "buyer",
      host: "marketplace",
      goal: "Find the Twilight Masquerade Elite Trainer Box shipment with tracking reference 1ZSEEDREVIEWELIGIBLE. Determine whether and when it was delivered, and reach the place to report a problem for the correct purchase. Do not submit a report, send a message, review, or buy anything.",
      checks: ["shipment-identity", "delivery-status-and-time", "problem-entry"],
      oracle: {
        "shipment-identity": "Reobserve the actual shipment identity against authoritative fixture data.",
        "delivery-status-and-time": "Reobserve the actual delivery status and time against authoritative fixture data.",
        "problem-entry": "Reaching generic instructions is not reaching the correct report form.",
      },
      routes: {
        "bounded-contexts/fulfillment/routes/marketplace/account-shipments.tsx": "shipment-identity",
        "bounded-contexts/fulfillment/routes/marketplace/account-shipment.tsx": "delivery-status-and-time",
      },
      paths: ["bounded-contexts/fulfillment/", "bounded-contexts/ordering/", "bounded-contexts/platform-operations/"],
      selectOnSharedChange: true,
    },
    {
      id: "buyer-cart-checkout",
      version: 1,
      startPath: "/account/cart",
      role: "buyer",
      host: "marketplace",
      goal: "cart; checkout start, session, and payment step (stop before confirming payment)",
      checks: ["cart", "checkout-boundary"],
      oracle: {
        cart: "Bootstrap seed: deployables/marketplace/e2e/support/seed-contract.ts, marketplaceBrowserE2eSeedContract.cart.",
        "checkout-boundary":
          "Bootstrap seed: deployables/marketplace/e2e/support/seed-contract.ts, marketplaceBrowserE2eSeedContract.cart.startedSessionId.",
      },
      routes: {
        "bounded-contexts/checkout/routes/account-cart.tsx": "cart",
        "bounded-contexts/checkout/routes/checkout-start.tsx": "checkout-boundary",
        "bounded-contexts/checkout/routes/checkout-session.tsx": "checkout-boundary",
        "bounded-contexts/payments/routes/marketplace/checkout-payment.tsx": "checkout-boundary",
      },
      paths: ["bounded-contexts/checkout/"],
      selectOnSharedChange: true,
    },
    {
      id: "buyer-profile",
      version: 1,
      startPath: "/account",
      role: "buyer",
      host: "marketplace",
      goal: "profile, security, consents, shipping addresses",
      checks: ["profile-state"],
      oracle: {
        "profile-state":
          "Bootstrap seed: bounded-contexts/identity/support/runtime-support/seed.ts, collector account reconciliation.",
      },
      routes: {
        "bounded-contexts/identity/routes/marketplace/account.tsx": "profile-state",
        "bounded-contexts/identity/routes/marketplace/account-security.tsx": "profile-state",
        "bounded-contexts/identity/routes/marketplace/account-consents.tsx": "profile-state",
        "bounded-contexts/identity/routes/marketplace/account-shipping-addresses.tsx": "profile-state",
      },
      paths: ["bounded-contexts/identity/"],
      selectOnSharedChange: true,
    },
    {
      id: "buyer-support-request",
      version: 1,
      startPath: "/account/support",
      role: "buyer",
      host: "marketplace",
      goal: "support requests and request detail",
      checks: ["support-request"],
      oracle: {
        "support-request":
          "Bootstrap seed: deployables/marketplace/e2e/support-case-detail.spec.ts, sup_seed_self_service_product_damaged.",
      },
      routes: {
        "bounded-contexts/platform-operations/routes/marketplace/account-support.tsx": "support-request",
        "bounded-contexts/platform-operations/routes/marketplace/account-support-detail.tsx": "support-request",
      },
      paths: ["bounded-contexts/platform-operations/"],
      selectOnSharedChange: true,
    },
  ],
  excludedRoutes: [
    {
      path: "bounded-contexts/auth/routes/marketplace/account-agents-detail.tsx",
      reason: "fixture-gap: bootstrap buyer agent with a detail view",
    },
    {
      path: "bounded-contexts/auth/routes/marketplace/account-agents.tsx",
      reason: "fixture-gap: bootstrap buyer agent",
    },
    {
      path: "bounded-contexts/auth/routes/marketplace/account-select.tsx",
      reason: "fixture-gap: second buyer account for account switching",
    },
    {
      path: "bounded-contexts/auth/routes/marketplace/account-sessions-detail.tsx",
      reason: "fixture-gap: second active buyer session",
    },
    {
      path: "bounded-contexts/auth/routes/marketplace/account-sessions.tsx",
      reason: "fixture-gap: second active buyer session",
    },
    { path: "bounded-contexts/checkout/routes/buy-checkout-confirmation.tsx", reason: "provider-step-only" },
    {
      path: "bounded-contexts/discovery/routes/account-product-alerts.tsx",
      reason: "fixture-gap: buyer product alert with a persisted alert status",
    },
    {
      path: "bounded-contexts/marketplace/routes/account-offer-match.tsx",
      reason: "fixture-gap: buyer submitted offer with a matching seller offer detail",
    },
    {
      path: "bounded-contexts/marketplace/routes/account-offer-matches.tsx",
      reason: "fixture-gap: buyer submitted offer with a matching seller offer",
    },
    {
      path: "bounded-contexts/marketplace/routes/account-offer-submitted.tsx",
      reason: "fixture-gap: submitted buyer offer",
    },
    {
      path: "bounded-contexts/marketplace/routes/account-offers-submitted.tsx",
      reason: "fixture-gap: submitted buyer offer",
    },
    {
      path: "bounded-contexts/marketplace/routes/marketplace/account-purchase-review.tsx",
      reason: "fixture-gap: delivered buyer purchase eligible for review",
    },
    {
      path: "bounded-contexts/marketplace/routes/marketplace/account-review-summary.tsx",
      reason: "fixture-gap: buyer-authored review eligible for summary",
    },
    {
      path: "bounded-contexts/marketplace/routes/marketplace/account-review.tsx",
      reason: "fixture-gap: buyer-authored review",
    },
    {
      path: "bounded-contexts/marketplace/routes/marketplace/account-written-reviews.tsx",
      reason: "fixture-gap: buyer-authored review",
    },
    {
      path: "bounded-contexts/notifications/routes/account-notifications.tsx",
      reason: "fixture-gap: buyer notification with a persisted delivery/read state",
    },
    {
      path: "bounded-contexts/ordering/routes/account-purchase.tsx",
      reason: "fixture-gap: completed purchase for the seeded browser buyer",
    },
    {
      path: "bounded-contexts/ordering/routes/account-purchases.tsx",
      reason: "fixture-gap: completed purchase for the seeded browser buyer",
    },
    {
      path: "bounded-contexts/payments/routes/marketplace/account-payment-methods.tsx",
      reason: "fixture-gap: saved payment method for the seeded browser buyer",
    },
    {
      path: "bounded-contexts/payments/routes/marketplace/account-payment-new.tsx",
      reason: "fixture-gap: saved payment method for the seeded browser buyer",
    },
    {
      path: "bounded-contexts/payments/routes/marketplace/account-payment.tsx",
      reason: "fixture-gap: saved payment method for the seeded browser buyer",
    },
  ],
};
