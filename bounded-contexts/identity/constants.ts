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
    "memberships.manage",
    "memberships.view",
    "inventory.manage",
    "inventory.view",
    "orders.manage",
    "orders.view",
    "security.manage",
  ],
  manager: [
    "accounts.view",
    "catalog.manage",
    "catalog.view",
    "memberships.manage",
    "memberships.view",
    "inventory.manage",
    "inventory.view",
    "orders.manage",
    "orders.view",
  ],
  fulfillment: ["accounts.view", "memberships.view", "inventory.view", "orders.view"],
  viewer: ["accounts.view", "memberships.view", "inventory.view", "orders.view"],
};
