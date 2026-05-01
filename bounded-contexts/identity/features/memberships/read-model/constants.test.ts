import { describe, expect, it } from "vitest";
import { ROLE_PERMISSIONS } from "./constants";

describe("identity role permissions", () => {
  it("grants owner authority for buying and selling workflows by default", () => {
    expect(ROLE_PERMISSIONS.owner).toEqual(
      expect.arrayContaining([
        "inventory.manage",
        "inventory.view",
        "listings.manage",
        "listings.view",
        "offers.manage",
        "offers.view",
        "orders.manage",
        "orders.view",
        "payouts.view",
      ]),
    );
  });

  it("keeps payout scheduling as an authority permission instead of an account capability", () => {
    expect(ROLE_PERMISSIONS.owner).toContain("payouts.manage");
    expect(ROLE_PERMISSIONS.owner).toContain("payouts.reconcile");
    expect(ROLE_PERMISSIONS.owner).toContain("payouts.request");
    expect(ROLE_PERMISSIONS.owner).toContain("payouts.setup");
    expect(ROLE_PERMISSIONS.viewer).toContain("payouts.view");
    expect(ROLE_PERMISSIONS.viewer).not.toContain("payouts.manage");
    expect(ROLE_PERMISSIONS.viewer).not.toContain("payouts.reconcile");
    expect(ROLE_PERMISSIONS.viewer).not.toContain("payouts.request");
    expect(ROLE_PERMISSIONS.viewer).not.toContain("payouts.setup");
  });
});
