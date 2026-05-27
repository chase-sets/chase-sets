import { describe, expect, it } from "vitest";
import { decideAccount, evolveAccount, initialAccountState } from "./domain";

describe("account domain", () => {
  it("creates and suspends an account", () => {
    const created = decideAccount(initialAccountState, {
      type: "CreateAccount",
      accountId: "acc_test" as never,
      name: "North Store LLC",
      accountType: "business",
      displayName: "North Store",
    });
    const createdState = created.reduce(evolveAccount, initialAccountState);
    const suspended = decideAccount(createdState, { type: "SuspendAccount" });
    const suspendedState = suspended.reduce(evolveAccount, createdState);

    expect(createdState.displayName).toBe("North Store");
    expect(suspendedState.status).toBe("suspended");
  });

  it("accepts enterprise accounts", () => {
    const created = decideAccount(initialAccountState, {
      type: "CreateAccount",
      accountId: "acc_enterprise" as never,
      name: "Enterprise Seller LLC",
      accountType: "enterprise",
      displayName: "Enterprise Seller",
    });
    const createdState = created.reduce(evolveAccount, initialAccountState);

    expect(createdState.accountType).toBe("enterprise");
  });

  it("assigns founding account badges idempotently", () => {
    const created = decideAccount(initialAccountState, {
      type: "CreateAccount",
      accountId: "acc_founder" as never,
      name: "Founding Store LLC",
      accountType: "business",
      displayName: "Founding Store",
    });
    const createdState = created.reduce(evolveAccount, initialAccountState);

    const assigned = decideAccount(createdState, {
      type: "AssignAccountBadge",
      badgeKey: "founding-account",
    });
    const assignedState = assigned.reduce(evolveAccount, createdState);
    const assignedAgain = decideAccount(assignedState, {
      type: "AssignAccountBadge",
      badgeKey: "founding-account",
    });

    expect(assigned).toEqual([
      {
        type: "identity.account.badge-assigned",
        data: { badgeKey: "founding-account" },
      },
    ]);
    expect(assignedState.badges).toEqual(["founding-account"]);
    expect(assignedAgain).toEqual([]);
  });

  it("removes account badges idempotently", () => {
    const createdState = decideAccount(initialAccountState, {
      type: "CreateAccount",
      accountId: "acc_founder" as never,
      name: "Founding Store LLC",
      accountType: "business",
      displayName: "Founding Store",
    }).reduce(evolveAccount, initialAccountState);
    const assignedState = decideAccount(createdState, {
      type: "AssignAccountBadge",
      badgeKey: "founding-account",
    }).reduce(evolveAccount, createdState);

    const removed = decideAccount(assignedState, {
      type: "RemoveAccountBadge",
      badgeKey: "founding-account",
    });
    const removedState = removed.reduce(evolveAccount, assignedState);
    const removedAgain = decideAccount(removedState, {
      type: "RemoveAccountBadge",
      badgeKey: "founding-account",
    });

    expect(removedState.badges).toEqual([]);
    expect(removedAgain).toEqual([]);
  });

  it("assigns seller trust and manual payout review badges", () => {
    const createdState = decideAccount(initialAccountState, {
      type: "CreateAccount",
      accountId: "acc_trust" as never,
      name: "Trust Review LLC",
      accountType: "business",
      displayName: "Trust Review",
    }).reduce(evolveAccount, initialAccountState);

    const trustedState = decideAccount(createdState, {
      type: "AssignAccountBadge",
      badgeKey: "trusted-seller",
    }).reduce(evolveAccount, createdState);
    const reviewState = decideAccount(trustedState, {
      type: "AssignAccountBadge",
      badgeKey: "manual-payout-review",
    }).reduce(evolveAccount, trustedState);

    expect(reviewState.badges).toEqual(["manual-payout-review", "trusted-seller"]);
  });
});
