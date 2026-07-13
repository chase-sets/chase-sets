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

  it("publishes the normalized grant-time recipient when the founders window opens", () => {
    const createdState = decideAccount(initialAccountState, {
      type: "CreateAccount",
      accountId: "acc_founder" as never,
      name: "Founding Store LLC",
      accountType: "business",
      displayName: "Founding Store",
    }).reduce(evolveAccount, initialAccountState);

    const opened = decideAccount(createdState, {
      type: "OpenFoundersWindow",
      betaAccessStartedAt: "2026-07-31T12:00:00.000Z",
      foundersWindowEndsAt: "2026-09-29T12:00:00.000Z",
      recipientEmail: " Founder@Example.COM ",
    });

    expect(opened).toEqual([
      {
        type: "identity.account.founders-window-opened",
        data: {
          betaAccessStartedAt: "2026-07-31T12:00:00.000Z",
          foundersWindowEndsAt: "2026-09-29T12:00:00.000Z",
          recipientEmail: "founder@example.com",
        },
      },
    ]);
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
      founderNumber: 47,
    });
    const assignedState = assigned.reduce(evolveAccount, createdState);
    const assignedAgain = decideAccount(assignedState, {
      type: "AssignAccountBadge",
      badgeKey: "founding-account",
      founderNumber: 47,
    });

    expect(assigned).toEqual([
      {
        type: "identity.account.badge-assigned",
        data: { badgeKey: "founding-account", founderNumber: 47 },
      },
    ]);
    expect(assignedState.badges).toEqual(["founding-account"]);
    expect(assignedState.founderNumber).toBe(47);
    expect(assignedAgain).toEqual([]);
  });

  it("removes operator-managed account badges idempotently", () => {
    const createdState = decideAccount(initialAccountState, {
      type: "CreateAccount",
      accountId: "acc_founder" as never,
      name: "Founding Store LLC",
      accountType: "business",
      displayName: "Founding Store",
    }).reduce(evolveAccount, initialAccountState);
    const assignedState = decideAccount(createdState, {
      type: "AssignAccountBadge",
      badgeKey: "manual-payout-review",
    }).reduce(evolveAccount, createdState);

    const removed = decideAccount(assignedState, {
      type: "RemoveAccountBadge",
      badgeKey: "manual-payout-review",
    });
    const removedState = removed.reduce(evolveAccount, assignedState);
    const removedAgain = decideAccount(removedState, {
      type: "RemoveAccountBadge",
      badgeKey: "manual-payout-review",
    });

    expect(removedState.badges).toEqual([]);
    expect(removedAgain).toEqual([]);
  });

  it("keeps numbered founding account badges permanent", () => {
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
      founderNumber: 47,
    }).reduce(evolveAccount, createdState);

    expect(() => decideAccount(assignedState, { type: "RemoveAccountBadge", badgeKey: "founding-account" })).toThrow(
      "Founding Account badges are permanent.",
    );
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
