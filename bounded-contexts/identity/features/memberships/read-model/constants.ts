import type { PermissionKey, RoleKey } from "../../../support/runtime-support/common";

export const IDENTITY_BOOTSTRAP_TENANT_ID = "tnt_identity" as const;
export const IDENTITY_BOOTSTRAP_USER_ID = "usr_identity_system" as const;
export const IDENTITY_BOOTSTRAP_ACCOUNT_ID = "acc_identity_system" as const;

export const PERMISSION_PRESETS = {
  paymentsOperator: ["orders.manage", "orders.view"],
  payoutsOperator: ["payouts.manage", "payouts.reconcile", "payouts.request", "payouts.setup", "payouts.view"],
  payoutsViewer: ["payouts.view"],
} satisfies Readonly<Record<string, readonly PermissionKey[]>>;

export const ROLE_PERMISSIONS = {
  "platform-admin": [
    "accounts.manage",
    "accounts.view",
    "catalog.manage",
    "catalog.view",
    "commercial-terms.manage",
    "commercial-terms.view",
    "google-shopping.manage",
    "google-shopping.view",
    "listing-evidence-policy.activate",
    "listing-evidence-policy.draft",
    "listing-evidence-policy.validate",
    "listing-evidence-policy.view",
    "insights-dashboards.view",
    "memberships.manage",
    "memberships.view",
    "postage-policies.manage",
    "postage-policies.view",
    "return-intake.manage",
    "return-intake.view",
    // Customer feedback operator capabilities: platform-staff only.
    // Export is a distinct grant from view/manage so the sensitive free-text
    // comment download can be withheld independently.
    "platform-feedback.export",
    "platform-feedback.manage",
    "platform-feedback.view",
    "platform-policy.manage",
    "platform-policy.view",
    "public-presence.manage",
    "public-presence.view",
    "recovered-inventory.evidence",
    "recovered-inventory.manage",
    "recovered-inventory.view",
    // Reported-content operator authority: platform-admin only. Gates the
    // admin-web Reported Content and Risk Alerts surfaces, the reported-content
    // moderation writes, and risk-alert action recording, so it confers
    // operator write authority despite the `.view` name. Must stay granted to
    // exactly the same role set as Auth's AUTH_ROLE_PERMISSIONS entry
    // (contract-tested in constants.test.ts) and never to an ordinary account
    // role.
    "reported-content.view",
    "security.manage",
    "support.manage",
    "support.remedies.approve",
    "support.remedies.approve-elevated",
    "support.remedies.correct",
    "support.remedies.override-return",
    "support.remedies.propose",
    "support.remedies.retry",
    "support.remedies.waive",
    "support.view",
    // Platform Wallet Adjustment authority (ADR 0020): platform-admin only.
    // Never granted via invitation/membership assignment -- platform-admin
    // itself can only be assigned by platform bootstrap (see
    // assertRoleAssignmentAllowed) -- and never bundled into payouts.*.
    "wallet-adjustments.approve",
    "wallet-adjustments.create",
    "wallet-adjustments.reverse",
    "wallet-adjustments.view",
  ],
  owner: [
    "accounts.manage",
    "accounts.view",
    "catalog.manage",
    "catalog.view",
    "commercial-terms.manage",
    "commercial-terms.view",
    "fulfillment.manage",
    "fulfillment.view",
    "google-shopping.manage",
    "google-shopping.view",
    "insights-dashboards.view",
    "memberships.manage",
    "memberships.view",
    "inventory.manage",
    "inventory.view",
    "listings.manage",
    "listings.view",
    "listing-evidence-policy.view",
    "offers.manage",
    "offers.view",
    "orders.manage",
    "orders.view",
    "postage-policies.manage",
    "postage-policies.view",
    ...PERMISSION_PRESETS.payoutsOperator,
    // Customer feedback operator capabilities are platform-staff only;
    // an account owner does not enumerate/export/mutate platform feedback.
    "platform-policy.view",
    "public-presence.manage",
    "public-presence.view",
    "reputation.manage",
    "reputation.view",
    "support.manage",
    "support.view",
    "security.manage",
  ],
  manager: [
    "accounts.view",
    "catalog.manage",
    "catalog.view",
    "commercial-terms.manage",
    "commercial-terms.view",
    "fulfillment.manage",
    "fulfillment.view",
    "google-shopping.manage",
    "google-shopping.view",
    "insights-dashboards.view",
    "memberships.manage",
    "memberships.view",
    "inventory.manage",
    "inventory.view",
    "listings.manage",
    "listings.view",
    "listing-evidence-policy.view",
    "offers.manage",
    "offers.view",
    "orders.manage",
    "orders.view",
    "postage-policies.manage",
    "postage-policies.view",
    ...PERMISSION_PRESETS.payoutsOperator,
    // Customer feedback operator capabilities are platform-staff only.
    "platform-policy.view",
    "public-presence.manage",
    "public-presence.view",
    "reputation.manage",
    "reputation.view",
    "support.manage",
    "support.view",
  ],
  fulfillment: [
    "accounts.view",
    "fulfillment.manage",
    "fulfillment.view",
    "memberships.view",
    "inventory.view",
    "listings.view",
    "offers.view",
    "orders.view",
    "return-intake.manage",
    "return-intake.view",
    // No platform-feedback.* -- operator feedback is platform-staff only.
    "public-presence.view",
    "reputation.view",
    "support.manage",
    "support.view",
  ],
  viewer: [
    "accounts.view",
    "fulfillment.view",
    "memberships.view",
    "inventory.view",
    "listings.view",
    "offers.view",
    "orders.view",
    ...PERMISSION_PRESETS.payoutsViewer,
    // No platform-feedback.* -- operator feedback is platform-staff only.
    "public-presence.view",
    "reputation.view",
    "support.view",
  ],
} satisfies Record<RoleKey, readonly PermissionKey[]>;
