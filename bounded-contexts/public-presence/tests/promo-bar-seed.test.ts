import { describe, expect, it, vi } from "vitest";
import { seedPublicPresencePromoBarMessages } from "../features/promo-bar/api/seed";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

function createDb() {
  return {
    query: vi.fn(async () => ({ rows: [], rowCount: 1 })),
  } satisfies PgQueryable;
}

describe("promo bar seed", () => {
  it("reconciles default public promo bar messages for bootstrap profiles", async () => {
    const db = createDb();

    await seedPublicPresencePromoBarMessages(db, {
      enabledDataProfiles: ["critical-bootstrap"],
      environmentName: "local",
    });

    expect(db.query).toHaveBeenCalledTimes(2);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("ON CONFLICT"), [
      "pbm_seed_shipping_credit",
      "Earn 5% toward shipping on all orders.",
      expect.any(String),
      "/order-protection",
      "Order protection",
      "success",
      10,
    ]);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("ON CONFLICT"), [
      "pbm_seed_beta_listing_fees",
      "0% seller fees on beta listings.",
      expect.any(String),
      "/sales-fees",
      "Seller fees",
      "info",
      20,
    ]);
  });

  it("skips when selected data profiles do not include bootstrap or scenario seed", async () => {
    const db = createDb();

    await seedPublicPresencePromoBarMessages(db, {
      enabledDataProfiles: ["catalog-integration-bootstrap"],
      environmentName: "local",
    });

    expect(db.query).not.toHaveBeenCalled();
  });
});
