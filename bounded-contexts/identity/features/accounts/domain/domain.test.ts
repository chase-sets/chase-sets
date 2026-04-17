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
});
