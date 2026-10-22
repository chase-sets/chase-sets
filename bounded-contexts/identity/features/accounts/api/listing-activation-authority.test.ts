import { describe, expect, it, vi } from "vitest";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createListingActivationAuthority } from "./listing-activation-authority";
import type { ListingActivationIdentityReader } from "./listing-activation-authority";

const context = {
  tenantId: "tenant_1" as EventStoreContext["tenantId"],
  audit: {
    performedByUserId: "usr_1" as EventStoreContext["audit"]["performedByUserId"],
    forAccountId: "acc_1" as EventStoreContext["audit"]["forAccountId"],
  },
} satisfies EventStoreContext;

function identity(overrides: Partial<ListingActivationIdentityReader> = {}): ListingActivationIdentityReader {
  const account = { state: { status: "active" }, version: 4 };
  const membership = {
    state: { userId: "usr_1", accountId: "acc_1", roleKey: "owner", status: "active" },
    version: 7,
  };
  const accounts: ListingActivationIdentityReader["accounts"] = {
    getAccountStateWithVersion: vi.fn(async () => account),
  };
  const memberships: ListingActivationIdentityReader["memberships"] = {
    getActiveMembershipForUserAccount: vi.fn(async () => ({
      membership_id: "mem_1",
      role_permissions: ["listings.manage"],
    })),
    getMembershipStateWithVersion: vi.fn(async () => membership),
  };
  return { accounts: overrides.accounts ?? accounts, memberships: overrides.memberships ?? memberships };
}

describe("Identity Listing activation authority", () => {
  it("requires the current account and owner membership", async () => {
    const result = await createListingActivationAuthority(identity()).authorizeManage({ accountId: "acc_1" }, context);
    expect(result.value).toBe(true);
    expect(
      result.reservations.map((reservation) => [
        reservation.ownerContext,
        reservation.streamId,
        reservation.expectedVersion,
      ]),
    ).toEqual([
      ["identity", "identity.account-acc_1", 4],
      ["identity", "identity.membership-mem_1", 7],
    ]);
  });

  it("fails closed for a manager without listings.manage", async () => {
    const result = await createListingActivationAuthority(
      identity({
        memberships: {
          getActiveMembershipForUserAccount: vi.fn(async () => ({ membership_id: "mem_1", role_permissions: [] })),
          getMembershipStateWithVersion: vi.fn(async () => ({
            state: { userId: "usr_1", accountId: "acc_1", roleKey: "manager", status: "active" },
            version: 1,
          })),
        },
      }),
    ).authorizeManage({ accountId: "acc_1" }, context);
    expect(result).toEqual({ value: false, reservations: [] });
  });

  it("revalidates both owner streams", async () => {
    const reader = identity();
    const authority = createListingActivationAuthority(reader);
    const result = await authority.authorizeManage({ accountId: "acc_1" }, context);
    await Promise.all(result.reservations.map((reservation) => reservation.assertCurrent()));
    expect(reader.accounts.getAccountStateWithVersion).toHaveBeenCalledTimes(2);
    expect(reader.memberships.getMembershipStateWithVersion).toHaveBeenCalledTimes(2);
  });
});
