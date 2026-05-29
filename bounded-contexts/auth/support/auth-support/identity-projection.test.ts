import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { authIdentityProjectionSchemaSql, getActiveAuthMembershipForUserAccount } from "./identity-projection";

const activeMembershipRow = Object.freeze({
  membership_id: "mem_platform_admin",
  user_id: "usr_platform_admin",
  account_id: "acc_platform_admin",
  role_key: "platform-admin",
  role_permissions: ["waitlist.manage"],
  status: "active",
  updated_at: "2026-05-25T00:00:00.000Z",
});

describe("auth identity membership reads", () => {
  it("resolves account membership from the user membership mirror used during sign-in", async () => {
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: [activeMembershipRow] }));
    const db = { query } as unknown as PgQueryable;

    await expect(
      getActiveAuthMembershipForUserAccount(db, "usr_platform_admin", "acc_platform_admin"),
    ).resolves.toEqual(activeMembershipRow);

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain("FROM auth_identity_user_memberships");
    expect(query.mock.calls[0]?.[1]).toEqual(["usr_platform_admin", "acc_platform_admin"]);
  });

  it("falls back to the membership mirror for deployments that have not rebuilt user membership rows", async () => {
    const query = vi
      .fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: [] as (typeof activeMembershipRow)[] }))
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [activeMembershipRow] });
    const db = { query } as unknown as PgQueryable;

    await expect(
      getActiveAuthMembershipForUserAccount(db, "usr_platform_admin", "acc_platform_admin"),
    ).resolves.toEqual(activeMembershipRow);

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]?.[0]).toContain("FROM auth_identity_user_memberships");
    expect(query.mock.calls[1]?.[0]).toContain("FROM auth_identity_memberships");
  });

  it("keeps request-time membership lookups indexed", () => {
    expect(authIdentityProjectionSchemaSql).toContain("auth_identity_user_memberships_user_status_idx");
    expect(authIdentityProjectionSchemaSql).toContain("auth_identity_user_memberships_user_account_status_idx");
    expect(authIdentityProjectionSchemaSql).toContain("auth_identity_memberships_user_account_status_idx");
  });
});
