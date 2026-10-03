export default {
  id: "seller",
  routeScope: [
    "^bounded-contexts/checkout/routes/(account-desk-offers|account-sell-list|sell-checkout-session|sell-checkout-confirmation)\\.tsx$",
    "^bounded-contexts/marketplace/routes/(account-desk|account-listing|account-listings|account-listings-new)\\.tsx$",
    "^bounded-contexts/marketplace/routes/marketplace/(account-received-reviews|account-sale-review)\\.tsx$",
    "^bounded-contexts/ordering/routes/account-sales?\\.tsx$",
    "^bounded-contexts/fulfillment/routes/marketplace/account-sale-",
    "^bounded-contexts/inventory/routes/marketplace/",
    "^bounded-contexts/pricing/routes/marketplace/(account-desk-repricing|account-desk-repricing-policy|account-repricing|bulk-reprice)\\.tsx$",
    "^bounded-contexts/settlement/routes/marketplace/",
    "^bounded-contexts/channels/routes/marketplace/",
    "^bounded-contexts/identity/routes/marketplace/account-team\\.tsx$",
  ],
  goals: [
    {
      id: "seller-away",
      version: 1,
      startPath: "/account",
      role: "seller",
      host: "marketplace",
      goal: "Schedule time away for the future dates supplied in your fixture task context, with automatic return. Then leave that area and come back to confirm the schedule. Change only this synthetic account's away window, not listings or prices.",
      checks: ["scheduled-dates", "canonical-state", "clean-route-readback", "fixture-restored"],
      oracle: {
        "scheduled-dates": "Away window in the seller availability read model for the synthetic seller.",
        "canonical-state":
          "Canonical command/event and fresh read-model state. A toast is not evidence of persistence.",
        "clean-route-readback": "A clean-route revisit without receipt parameters.",
        "fixture-restored": "Restoration of the same synthetic account's initially empty schedule.",
      },
      routes: {
        "bounded-contexts/marketplace/routes/account-listings.tsx": "scheduled-dates",
      },
      paths: [
        "bounded-contexts/marketplace/features/listings/",
        "bounded-contexts/marketplace/routes/account-listings",
      ],
      permits: "You may schedule time away for the dates in your task context.",
      selectOnSharedChange: true,
    },
  ],
  excludedRoutes: [],
};
