import type { PermissionKey, RoleKey } from "./common";

export const IDENTITY_BOOTSTRAP_TENANT_ID = "tnt_identity" as const;
export const IDENTITY_BOOTSTRAP_USER_ID = "usr_identity_system" as const;
export const IDENTITY_BOOTSTRAP_ACCOUNT_ID = "acc_identity_system" as const;

export const ROLE_PERMISSIONS: Record<RoleKey, readonly PermissionKey[]> = {
  owner: [
    "accounts.manage",
    "accounts.view",
    "catalog.manage",
    "catalog.view",
    "fulfillment.manage",
    "fulfillment.view",
    "memberships.manage",
    "memberships.view",
    "inventory.manage",
    "inventory.view",
    "listings.manage",
    "listings.view",
    "offers.manage",
    "offers.view",
    "orders.manage",
    "orders.view",
    "security.manage",
  ],
  manager: [
    "accounts.view",
    "catalog.manage",
    "catalog.view",
    "fulfillment.manage",
    "fulfillment.view",
    "memberships.manage",
    "memberships.view",
    "inventory.manage",
    "inventory.view",
    "listings.manage",
    "listings.view",
    "offers.manage",
    "offers.view",
    "orders.manage",
    "orders.view",
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
  ],
  viewer: [
    "accounts.view",
    "fulfillment.view",
    "memberships.view",
    "inventory.view",
    "listings.view",
    "offers.view",
    "orders.view",
  ],
};
