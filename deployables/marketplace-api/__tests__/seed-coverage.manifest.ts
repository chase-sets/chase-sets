export const seedCoverageManifest = {
  identity: {
    accounts: ["active", "suspended"],
    users: ["active", "suspended", "password", "passkey"],
    memberships: ["active", "role-changed", "revoked", "reinstated"],
    invitations: ["accepted", "declined", "cancelled", "expired"],
    sessions: ["active", "switched", "expired"],
    apiKeys: ["active", "rotated", "revoked"],
    consents: ["recorded"],
  },
  catalog: {
    authoring: ["active reference data"],
  },
  inventory: {
    storageLocations: ["active", "archived"],
    records: ["created", "adjusted"],
    holds: ["active", "released"],
    catalogItems: ["projected from catalog"],
  },
  marketplace: {
    listings: ["draft", "active", "paused", "withdrawn"],
    offers: ["submitted", "accepted"],
  },
  ordering: {
    cart: ["active"],
    orders: ["pending-payment", "cancelled", "ready-for-fulfillment"],
  },
  payments: {
    payments: ["pending-confirmation", "captured", "failed", "cancelled"],
    refunds: ["issued", "failed"],
  },
  fulfillment: {
    shipments: [
      "awaiting-label",
      "label-attached",
      "dispatched",
      "delivered",
      "returned",
      "exception",
    ],
  },
  reputation: {
    reviews: ["active-updated", "withdrawn"],
    summaries: ["projected from active reviews"],
  },
  settlement: {
    wallets: ["opened", "pending-entry", "available-entry", "available-debit"],
    payouts: ["completed", "failed"],
  },
} as const;
