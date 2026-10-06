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
      startPath: "/",
      role: "buyer",
      host: "marketplace",
      goal: "You already have a couple of items waiting in your cart. Check what is in it and what it will cost, then go ahead and check out with standard delivery to your saved home address, until you reach the step that asks you to pay. Stop there: do not enter card details, confirm, or pay. Report the total and the delivery option you were shown at that point.",
      checks: ["cart-contents", "checkout-session", "payment-step", "cart-restored"],
      oracle: {
        "cart-contents":
          "Bootstrap seed: the two checkout seed cart lines for the synthetic buyer (checkoutSeedIds.cartLines, seedCheckoutDatabase). Compare the reported items and estimated total with the cart read model.",
        "checkout-session":
          "Checkout session read model: a session started from the seeded cart by this run, carrying the delivery option and address the participant chose. The cart page alone is not a session.",
        "payment-step":
          "Checkout session and payment read models: the run's session carries a payment in pending-confirmation and nothing captured. The payment entry renders on the checkout session page itself, so this check claims no separate payment page. If the sandbox has no payment processor and the session never leaves its preparing state, record environment-invalid rather than a product failure.",
        "cart-restored":
          "Before restoration, record the session and payment ids this run created. Restoration is the moderator's owned isolated sandbox refresh (pnpm run dev:db:refresh in the moderator's worktree: scripts/dev-system.mjs runRefresh destroys that sandbox's Postgres volume and re-runs bootstrap), never a shared or live seat. Afterwards read back both: the cart read model holds exactly the two seeded cart lines (checkoutSeedIds.cartLines), and each recorded run-created session and payment is absent or terminal, with no pending-confirmation payment left. Re-running the checkout seed alone reconciles only the seeded lines and the reserved bootstrap session; it closes nothing this run created and is not restoration.",
      },
      routes: {
        "bounded-contexts/checkout/routes/account-cart.tsx": "cart-contents",
        "bounded-contexts/checkout/routes/checkout-session.tsx": "checkout-session",
      },
      paths: [
        "bounded-contexts/checkout/features/cart/",
        "bounded-contexts/checkout/features/sessions/",
        "bounded-contexts/payments/features/payments/",
      ],
      permits:
        "You may check out the items already in your cart and continue up to the payment step for this synthetic account.",
    },
    {
      id: "buyer-checkout-readiness",
      version: 1,
      startPath: "/checkout/buy/readiness",
      role: "buyer",
      host: "marketplace",
      goal: "You are about to buy the items waiting in your cart and want to be sure nothing will hold the order up. Find out whether your cart is ready to check out, how many items would be included, and whether anything needs your attention first. Stop before you go any further: do not start a checkout or buy anything.",
      checks: ["readiness-status"],
      oracle: {
        "readiness-status":
          "Checkout cart readiness snapshot for the synthetic buyer (createCartReadinessSnapshot over the two seeded cart lines, checkoutSeedIds.cartLines): status ready, two lines, no customer-safe facts. Compare the readiness, item count and absence of warnings the participant reports. The readiness page is a read-only GET until its form is submitted, so the checkout session read model must show no session created by this run.",
      },
      routes: {
        "bounded-contexts/checkout/routes/checkout-start.tsx": "readiness-status",
      },
      paths: [
        "bounded-contexts/checkout/features/sessions/ui/checkout-start",
        "bounded-contexts/checkout/support/route-support/buy-checkout-readiness/",
      ],
    },
    {
      id: "buyer-payment-record",
      version: 1,
      startPath: "/account/payments/pay_seed_review_eligible_captured",
      role: "buyer",
      host: "marketplace",
      goal: "You have opened the payment record for a sealed product you bought and want to be sure the money actually went through. Confirm the payment's current status, the total that was charged, when it was taken, and which purchase it paid for. Do not retry, start, or change any payment.",
      checks: ["payment-record"],
      oracle: {
        "payment-record":
          "Bootstrap seed payment paymentsReservedSeedIds.payments.reviewEligibleCaptured (seedPaymentsDatabase, seedReservedPayments): status captured, captured 2026-03-20T11:35Z, amount equal to the covered order total in the payment read model, covering the review-eligible delivered order (reputationReservedSeedIds.orders.reviewEligibleDelivered). Compare status, captured time, total and covered purchase; the payments read model must show no payment command by this run. If the seeded payment is absent because bootstrap has not completed its passes, record environment-invalid.",
      },
      routes: {
        "bounded-contexts/payments/routes/marketplace/account-payment.tsx": "payment-record",
      },
      paths: ["bounded-contexts/payments/features/payments/ui/account-payment/"],
    },
    {
      id: "buyer-pending-purchase",
      version: 1,
      startPath: "/account",
      role: "buyer",
      host: "marketplace",
      goal: "You think one of your purchases was never paid for. Find out how many purchases are still waiting on payment, which item the unpaid one is for, how much is due and any payment deadline, then go as far as the screen where that payment would be started and stop there. Do not start or complete a payment.",
      checks: ["pending-count", "amount-and-deadline", "payment-start-screen"],
      oracle: {
        "pending-count":
          "Ordering purchase read model for the synthetic buyer: the pending-payment count in the purchases summary (bootstrap seed order orderingReservedSeedIds.orders.checkoutPending from seedOrderingDatabase).",
        "amount-and-deadline":
          "Purchase read model for orderingReservedSeedIds.orders.checkoutPending: item, total amount, and payment deadline. Compare with what the participant reports.",
        "payment-start-screen":
          "Payments read model: no payment created by this run for the synthetic buyer. The final screenshot shows the payment start summary for that purchase, not a payment element or confirmation.",
      },
      routes: {
        "bounded-contexts/ordering/routes/account-purchases.tsx": "pending-count",
        "bounded-contexts/ordering/routes/account-purchase.tsx": "amount-and-deadline",
        "bounded-contexts/payments/routes/marketplace/account-payment-new.tsx": "payment-start-screen",
      },
      paths: ["bounded-contexts/ordering/features/orders/"],
    },
    {
      id: "buyer-payment-methods",
      version: 1,
      startPath: "/account",
      role: "buyer",
      host: "marketplace",
      goal: "Before your next purchase you want to know which payment methods are already saved to your account and which one would be used by default. Find out, and report the last digits of each. Do not add, remove, or change a payment method.",
      checks: ["saved-methods"],
      oracle: {
        "saved-methods":
          "Bootstrap seed: payments_saved_checkout_instruments rows for the synthetic buyer written by seedPaymentsDatabase (sci_seed_collector_card is the default, sci_seed_collector_bank is not). Compare display names and the default flag.",
      },
      routes: {
        "bounded-contexts/payments/routes/marketplace/account-payment-methods.tsx": "saved-methods",
      },
      paths: ["bounded-contexts/payments/routes/marketplace/account-payment-methods"],
    },
    {
      id: "buyer-offers",
      version: 1,
      startPath: "/account",
      role: "buyer",
      host: "marketplace",
      goal: "You have made several offers to buy cards and sealed product and want to know where they stand. Find out how many offers you have outstanding and which ones have been accepted, and for your highest offer on a Base Set Charizard, report the price and quantity you asked for. Do not make, change, or withdraw an offer.",
      checks: ["offer-status", "offer-terms"],
      oracle: {
        "offer-status":
          "Marketplace offer read model for the synthetic buyer: every seed offer without a buyerAccountId override belongs to the collector (seedMarketplaceDatabase offers list); marketplaceReservedSeedIds.offers.twilightMasqueradeEliteTrainerSubmitted and twilightMasqueradeEliteTrainerEncore are accepted.",
        "offer-terms":
          "Bootstrap seed offer marketplaceReservedSeedIds.offers.charizardBaseSetNearMint: 350.00 USD for quantity 1. Reobserve on the submitted offer detail.",
      },
      routes: {
        "bounded-contexts/marketplace/routes/account-offers-submitted.tsx": "offer-status",
        "bounded-contexts/marketplace/routes/account-offer-submitted.tsx": "offer-terms",
      },
      paths: ["bounded-contexts/marketplace/features/offers/"],
    },
    {
      id: "buyer-reviews",
      version: 1,
      startPath: "/account",
      role: "buyer",
      host: "marketplace",
      goal: "You want to know how your feedback stands. Find the review you left for a seller after a sealed product arrived, including the rating you gave and whether the seller has replied, and confirm which purchase that review belongs to. Then see what has been said about you as a buyer. Do not write, reply to, or report a review.",
      checks: ["written-review", "review-purchase", "received-summary"],
      oracle: {
        "written-review":
          "Bootstrap seed review reputationReservedSeedIds.reviews.buyerToSellerActive (seedReputationData): submitted at 4 stars, then updated to 5 stars before reveal, so the final seed state is rating 5 by the synthetic buyer about the demo seller with no reply. Compare the rating and the reply state against the review read model, not the first seed command.",
        "review-purchase":
          "Review detail read model for reputationReservedSeedIds.reviews.buyerToSellerActive: its order is reputationReservedSeedIds.orders.reviewEligibleDelivered, the delivered Twilight Masquerade Elite Trainer Box purchase. Only the review's own page links to that purchase; the written-reviews list shows rating and reply state without it, so the evidence must show the review's own page, not the list.",
        "received-summary":
          "Reputation summary read model for the synthetic buyer account: the only seller-to-buyer seed review (reputationReservedSeedIds.reviews.sellerToBuyerWithdrawn) is withdrawn, so no active received review should be reported.",
      },
      routes: {
        "bounded-contexts/marketplace/routes/marketplace/account-written-reviews.tsx": "written-review",
        "bounded-contexts/marketplace/routes/marketplace/account-review.tsx": "review-purchase",
        "bounded-contexts/marketplace/routes/marketplace/account-review-summary.tsx": "received-summary",
      },
      paths: ["bounded-contexts/marketplace/features/reviews/"],
    },
    {
      id: "buyer-profile",
      version: 1,
      startPath: "/account",
      role: "buyer",
      host: "marketplace",
      goal: "You are checking that your account details are right before you buy again. Find the name your account shows to other people, the shipping address that would be used by default, which sign-in methods are turned on, and the version and date of the terms you agreed to. Do not change anything or enter a password.",
      checks: ["display-name", "default-address", "sign-in-methods", "terms-consent"],
      oracle: {
        "display-name":
          "Bootstrap seed identity account identitySeedIds.collector.accountId (identity runtime seed): display name Collector Zero.",
        "default-address":
          "Bootstrap seed shipping address book for the collector (identitySeedIds.collector.shippingAddressId): the Home address at 42 Binder Lane, Evanston, IL 60201, marked default.",
        "sign-in-methods":
          "Bootstrap seed user identitySeedIds.collector.userId: password enabled and no passkey. Compare with the security page.",
        "terms-consent":
          "Bootstrap seed consent identitySeedIds.collector.consentId: terms-of-service v1 recorded 2026-03-03.",
      },
      routes: {
        "bounded-contexts/identity/routes/marketplace/account.tsx": "display-name",
        "bounded-contexts/identity/routes/marketplace/account-shipping-addresses.tsx": "default-address",
        "bounded-contexts/identity/routes/marketplace/account-security.tsx": "sign-in-methods",
        "bounded-contexts/identity/routes/marketplace/account-consents.tsx": "terms-consent",
      },
      paths: [
        "bounded-contexts/identity/features/accounts/",
        "bounded-contexts/identity/features/shipping-addresses/",
        "bounded-contexts/identity/features/users/",
        "bounded-contexts/identity/features/consents/",
      ],
    },
    {
      id: "buyer-access",
      version: 1,
      startPath: "/account",
      role: "buyer",
      host: "marketplace",
      goal: "You are worried someone else might be signed in to your account. Find every sign-in on record, report which ones are still active and when the one you are using now expires, and check whether any outside app or assistant has been given access to shop for you. Do not sign anything out, and do not connect or disconnect anything.",
      checks: ["active-sessions", "current-session-expiry", "connected-agents"],
      oracle: {
        "active-sessions":
          "Auth session read model (identity_sessions) for identitySeedIds.collector.userId: the seeded session identitySeedIds.collector.sessionId is expired by seedAuthDatabase and the moderator's sign-in session is active. Compare counts and statuses.",
        "current-session-expiry":
          "The moderator's own session row: the expiry shown on its detail page matches the read model.",
        "connected-agents":
          "Agent grant read model for the collector: no bootstrap seed creates a grant, so the correct answer is none. The connected agents page must still have been reached.",
      },
      routes: {
        "bounded-contexts/auth/routes/marketplace/account-sessions.tsx": "active-sessions",
        "bounded-contexts/auth/routes/marketplace/account-sessions-detail.tsx": "current-session-expiry",
        "bounded-contexts/auth/routes/marketplace/account-agents.tsx": "connected-agents",
      },
      paths: ["bounded-contexts/auth/features/sessions/", "bounded-contexts/auth/features/agent-grants/"],
    },
    {
      id: "buyer-support-request",
      version: 1,
      startPath: "/account",
      role: "buyer",
      host: "marketplace",
      goal: "A sealed product you bought arrived with a damaged corner and you already told support about it. Find that request, report what has happened with it so far and what evidence is attached, and find out whether any of your other requests ended with money back and how much. Do not open a new request, add anything to one, or send a message.",
      checks: ["request-status", "request-evidence", "refund-outcome"],
      oracle: {
        "request-status":
          "Bootstrap seed support request supportSeedIds.supportRequests.selfServiceProductDamaged (seedSupportDatabase): open, product-damaged, opened 2026-07-15. Compare the status the participant reports.",
        "request-evidence":
          "The same request's committed evidence: one buyer attestation and one photo entry. The detail page must show both.",
        "refund-outcome":
          "Bootstrap seed support request supportSeedIds.supportRequests.resolvedPartialRefund: resolved with a 5.00 refund. Compare amount and outcome.",
      },
      routes: {
        "bounded-contexts/platform-operations/routes/marketplace/account-support.tsx": "request-status",
        "bounded-contexts/platform-operations/routes/marketplace/account-support-detail.tsx": "request-evidence",
      },
      paths: ["bounded-contexts/platform-operations/features/support-requests/"],
    },
    {
      id: "buyer-notification-center",
      version: 1,
      startPath: "/account/notifications",
      role: "buyer",
      host: "marketplace",
      goal: "You want to catch up on anything you have been notified about. Find out how many notifications are waiting for you unread and what the most recent one is about, or confirm that there are none. Then check which ways of being notified are switched on for your account and whether you have any product alerts set up. Do not mark anything as read, and do not change a preference or a product alert.",
      checks: ["unread-notifications", "notification-settings"],
      oracle: {
        "unread-notifications":
          "Web notification read model (web_notifications rows for identitySeedIds.collector.accountId): no bootstrap seed writes this table, so rows exist only where the worker dispatched web deliveries from seeded source events, and none is a correct answer when the account has no rows. Compare the unread count (read_at null) and the newest row's title with what the participant reports, and confirm no read_at was written by this run. If the page shows that notifications could not be loaded, record environment-invalid rather than a wrong answer.",
        "notification-settings":
          "Notification preference read model: notification_preferences holds no row for the collector (the notifications context has no seed), so the page shows defaultNotificationPreferences: web, email and product alerts on, sms and rcs off. No discovery seed creates a product alert for the collector, so the product alerts section is empty. Compare both; the preference and product alert read models must show no write by this run.",
      },
      routes: {
        "bounded-contexts/notifications/routes/account-notifications.tsx": "unread-notifications",
      },
      paths: [
        "bounded-contexts/notifications/features/notification-center/",
        "bounded-contexts/notifications/features/preferences/",
        "bounded-contexts/discovery/features/product-alerts/",
      ],
    },
  ],
  excludedRoutes: [
    {
      path: "bounded-contexts/auth/routes/marketplace/account-agents-detail.tsx",
      reason: "fixture-gap: agent grant for the seeded buyer to open in detail; no bootstrap seed connects an agent",
    },
    {
      path: "bounded-contexts/auth/routes/marketplace/account-select.tsx",
      reason:
        "fixture-gap: second account membership for the seeded buyer so sign-in issues an account selection step; the collector owns exactly one account",
    },
    { path: "bounded-contexts/checkout/routes/buy-checkout-confirmation.tsx", reason: "provider-step-only" },
    { path: "bounded-contexts/discovery/routes/account-product-alerts.tsx", reason: "redirect-only" },
    {
      path: "bounded-contexts/marketplace/routes/account-offer-match.tsx",
      reason:
        "fixture-gap: active listing owned by the seeded buyer account; offer matches are shown against the viewer's own listings",
    },
    {
      path: "bounded-contexts/marketplace/routes/account-offer-matches.tsx",
      reason:
        "fixture-gap: active listing owned by the seeded buyer account; offer matches are shown against the viewer's own listings",
    },
    {
      path: "bounded-contexts/marketplace/routes/marketplace/account-purchase-review.tsx",
      reason:
        "fixture-gap: delivered purchase for the seeded buyer with an open, unreviewed review window; the seeded delivered orders are already reviewed or held by open support requests",
    },
    {
      path: "bounded-contexts/payments/routes/marketplace/checkout-payment.tsx",
      reason:
        "fixture-gap: guest-buyer checkout session; the signed-in seeded buyer is routed to the account payment page instead",
    },
  ],
};
