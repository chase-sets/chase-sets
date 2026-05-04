import { describe, expect, it } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createCommercialTermsResolver } from "./resolve";

function createDb(options: Readonly<{
  accountType?: "personal" | "business" | "enterprise";
  accountStatus?: string;
  schedule?: {
    schedule_id: string;
    marketplace_sales_fee_percentage_bps: number;
    marketplace_sales_fee_fixed_amount: string;
    shipping_allowance_percentage_bps?: number;
  } | null;
  agreement?: {
    agreement_id: string;
    marketplace_sales_fee_percentage_bps: number;
    marketplace_sales_fee_fixed_amount: string;
    shipping_allowance_percentage_bps?: number;
  } | null;
}>): PgQueryable {
  return {
    query: async <TRow>(sql: string) => {
      if (sql.includes("FROM commercial_terms_account_pages")) {
        return {
          rows: [
            {
              account_id: "acc_test",
              account_type: options.accountType ?? "business",
              status: options.accountStatus ?? "active",
            },
          ] as TRow[],
        };
      }

      if (sql.includes("FROM commercial_terms_schedule_pages")) {
        return {
          rows: options.schedule ? [options.schedule as TRow] : [],
        };
      }

      if (sql.includes("FROM commercial_terms_agreement_pages")) {
        return {
          rows: options.agreement ? [options.agreement as TRow] : [],
        };
      }

      throw new Error(`Unexpected SQL: ${sql}`);
    },
  } as PgQueryable;
}

describe("commercial terms resolver", () => {
  it("resolves the default schedule for personal accounts", async () => {
    const resolver = createCommercialTermsResolver({
      db: createDb({
        accountType: "personal",
        schedule: {
          schedule_id: "cts_personal",
          marketplace_sales_fee_percentage_bps: 900,
          marketplace_sales_fee_fixed_amount: "0.15",
        },
      }),
    });

    const result = await resolver.resolveListingTerms({
      accountId: "acc_test",
      amount: "10.00",
      effectiveAt: "2026-04-16T10:00:00.000Z",
    });

    expect(result.accountType).toBe("personal");
    expect(result.marketplaceSalesFeeUnitAmount).toBe("1.05");
    expect(result.sellerNetUnitAmount).toBe("8.95");
    expect(result.shippingAllowancePercentageBps).toBe(500);
    expect(result.scheduleId).toBe("cts_personal");
    expect(result.agreementId).toBeNull();
  });

  it("resolves the default schedule for business accounts", async () => {
    const resolver = createCommercialTermsResolver({
      db: createDb({
        accountType: "business",
        schedule: {
          schedule_id: "cts_business",
          marketplace_sales_fee_percentage_bps: 850,
          marketplace_sales_fee_fixed_amount: "0.10",
        },
      }),
    });

    const result = await resolver.resolveListingTerms({
      accountId: "acc_test",
      amount: "10.00",
      effectiveAt: "2026-04-16T10:00:00.000Z",
    });

    expect(result.accountType).toBe("business");
    expect(result.marketplaceSalesFeeUnitAmount).toBe("0.95");
    expect(result.sellerNetUnitAmount).toBe("9.05");
    expect(result.scheduleId).toBe("cts_business");
    expect(result.agreementId).toBeNull();
  });

  it("resolves the default schedule for enterprise accounts", async () => {
    const resolver = createCommercialTermsResolver({
      db: createDb({
        accountType: "enterprise",
        schedule: {
          schedule_id: "cts_enterprise",
          marketplace_sales_fee_percentage_bps: 500,
          marketplace_sales_fee_fixed_amount: "0.25",
        },
      }),
    });

    const result = await resolver.resolveListingTerms({
      accountId: "acc_test",
      amount: "10.00",
      effectiveAt: "2026-04-16T10:00:00.000Z",
    });

    expect(result.accountType).toBe("enterprise");
    expect(result.marketplaceSalesFeeUnitAmount).toBe("0.75");
    expect(result.sellerNetUnitAmount).toBe("9.25");
    expect(result.scheduleId).toBe("cts_enterprise");
    expect(result.agreementId).toBeNull();
  });

  it("prefers an active agreement over the default schedule", async () => {
    const resolver = createCommercialTermsResolver({
      db: createDb({
        schedule: {
          schedule_id: "cts_default",
          marketplace_sales_fee_percentage_bps: 500,
          marketplace_sales_fee_fixed_amount: "0.25",
        },
        agreement: {
          agreement_id: "cag_enterprise",
          marketplace_sales_fee_percentage_bps: 250,
          marketplace_sales_fee_fixed_amount: "0.10",
          shipping_allowance_percentage_bps: 750,
        },
      }),
    });

    const result = await resolver.resolveOrderTerms({
      accountId: "acc_test",
      amount: "20.00",
      effectiveAt: "2026-04-16T10:00:00.000Z",
    });

    expect(result.marketplaceSalesFeeUnitAmount).toBe("0.60");
    expect(result.sellerNetUnitAmount).toBe("19.40");
    expect(result.shippingAllowancePercentageBps).toBe(750);
    expect(result.scheduleId).toBe("cts_default");
    expect(result.agreementId).toBe("cag_enterprise");
  });

  it("uses the schedule shipping allowance when no account agreement overrides it", async () => {
    const resolver = createCommercialTermsResolver({
      db: createDb({
        schedule: {
          schedule_id: "cts_default",
          marketplace_sales_fee_percentage_bps: 500,
          marketplace_sales_fee_fixed_amount: "0.25",
          shipping_allowance_percentage_bps: 625,
        },
      }),
    });

    const result = await resolver.resolveListingTerms({
      accountId: "acc_test",
      amount: "20.00",
      effectiveAt: "2026-04-16T10:00:00.000Z",
    });

    expect(result.shippingAllowancePercentageBps).toBe(625);
  });

  it("falls back to the schedule when the account agreement is inactive or out of range", async () => {
    const resolver = createCommercialTermsResolver({
      db: createDb({
        accountType: "business",
        schedule: {
          schedule_id: "cts_default",
          marketplace_sales_fee_percentage_bps: 500,
          marketplace_sales_fee_fixed_amount: "0.25",
        },
        agreement: null,
      }),
    });

    const result = await resolver.resolveOrderTerms({
      accountId: "acc_test",
      amount: "20.00",
      effectiveAt: "2026-04-16T10:00:00.000Z",
    });

    expect(result.scheduleId).toBe("cts_default");
    expect(result.agreementId).toBeNull();
    expect(result.marketplaceSalesFeeUnitAmount).toBe("1.25");
    expect(result.sellerNetUnitAmount).toBe("18.75");
  });

  it("rounds positive fractional-cent marketplace sales fees up to one cent", async () => {
    const resolver = createCommercialTermsResolver({
      db: createDb({
        schedule: {
          schedule_id: "cts_low_value",
          marketplace_sales_fee_percentage_bps: 500,
          marketplace_sales_fee_fixed_amount: "0.00",
        },
      }),
    });

    const result = await resolver.resolveListingTerms({
      accountId: "acc_test",
      amount: "0.02",
      effectiveAt: "2026-04-16T10:00:00.000Z",
    });

    expect(result.marketplaceSalesFeeUnitAmount).toBe("0.01");
    expect(result.sellerNetUnitAmount).toBe("0.01");
  });

  it("fails when the account is not active", async () => {
    const resolver = createCommercialTermsResolver({
      db: createDb({
        accountStatus: "suspended",
        schedule: {
          schedule_id: "cts_business",
          marketplace_sales_fee_percentage_bps: 850,
          marketplace_sales_fee_fixed_amount: "0.10",
        },
      }),
    });

    await expect(
      resolver.resolveListingTerms({
        accountId: "acc_test",
        amount: "12.00",
        effectiveAt: "2026-04-16T10:00:00.000Z",
      }),
    ).rejects.toThrow("is not active");
  });

  it("fails when no active schedule or agreement exists", async () => {
    const resolver = createCommercialTermsResolver({
      db: createDb({
        schedule: null,
        agreement: null,
      }),
    });

    await expect(
      resolver.resolveListingTerms({
        accountId: "acc_test",
        amount: "12.00",
        effectiveAt: "2026-04-16T10:00:00.000Z",
      }),
    ).rejects.toThrow("No active commercial terms were found");
  });
});
