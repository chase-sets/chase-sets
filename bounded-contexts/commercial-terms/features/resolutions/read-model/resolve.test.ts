import { describe, expect, it } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createCommercialTermsResolver } from "./resolve";

function createDb(options: Readonly<{
  accountType?: "personal" | "business" | "enterprise";
  accountStatus?: string;
  schedule?: {
    schedule_id: string;
    marketplace_fee_percentage_bps: number;
    marketplace_fee_fixed_amount: string;
    payment_fee_percentage_bps: number;
    payment_fee_fixed_amount: string;
  } | null;
  agreement?: {
    agreement_id: string;
    marketplace_fee_percentage_bps: number;
    marketplace_fee_fixed_amount: string;
    payment_fee_percentage_bps: number;
    payment_fee_fixed_amount: string;
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
          marketplace_fee_percentage_bps: 900,
          marketplace_fee_fixed_amount: "0.15",
          payment_fee_percentage_bps: 300,
          payment_fee_fixed_amount: "0.30",
        },
      }),
    });

    const result = await resolver.resolveListingTerms({
      sellerAccountId: "acc_test",
      amount: "10.00",
      effectiveAt: "2026-04-16T10:00:00.000Z",
    });

    expect(result.accountType).toBe("personal");
    expect(result.marketplaceFeeAmount).toBe("1.05");
    expect(result.paymentFeeAmount).toBe("0.60");
    expect(result.sellerNetAmount).toBe("8.35");
    expect(result.scheduleId).toBe("cts_personal");
    expect(result.agreementId).toBeNull();
  });

  it("resolves the default schedule for business accounts", async () => {
    const resolver = createCommercialTermsResolver({
      db: createDb({
        accountType: "business",
        schedule: {
          schedule_id: "cts_business",
          marketplace_fee_percentage_bps: 850,
          marketplace_fee_fixed_amount: "0.10",
          payment_fee_percentage_bps: 290,
          payment_fee_fixed_amount: "0.30",
        },
      }),
    });

    const result = await resolver.resolveListingTerms({
      sellerAccountId: "acc_test",
      amount: "10.00",
      effectiveAt: "2026-04-16T10:00:00.000Z",
    });

    expect(result.accountType).toBe("business");
    expect(result.marketplaceFeeAmount).toBe("0.95");
    expect(result.paymentFeeAmount).toBe("0.59");
    expect(result.sellerNetAmount).toBe("8.46");
    expect(result.scheduleId).toBe("cts_business");
    expect(result.agreementId).toBeNull();
  });

  it("resolves the default schedule for enterprise accounts", async () => {
    const resolver = createCommercialTermsResolver({
      db: createDb({
        accountType: "enterprise",
        schedule: {
          schedule_id: "cts_enterprise",
          marketplace_fee_percentage_bps: 500,
          marketplace_fee_fixed_amount: "0.25",
          payment_fee_percentage_bps: 300,
          payment_fee_fixed_amount: "0.30",
        },
      }),
    });

    const result = await resolver.resolveListingTerms({
      sellerAccountId: "acc_test",
      amount: "10.00",
      effectiveAt: "2026-04-16T10:00:00.000Z",
    });

    expect(result.accountType).toBe("enterprise");
    expect(result.marketplaceFeeAmount).toBe("0.75");
    expect(result.paymentFeeAmount).toBe("0.60");
    expect(result.sellerNetAmount).toBe("8.65");
    expect(result.scheduleId).toBe("cts_enterprise");
    expect(result.agreementId).toBeNull();
  });

  it("prefers an active agreement over the default schedule", async () => {
    const resolver = createCommercialTermsResolver({
      db: createDb({
        schedule: {
          schedule_id: "cts_default",
          marketplace_fee_percentage_bps: 500,
          marketplace_fee_fixed_amount: "0.25",
          payment_fee_percentage_bps: 300,
          payment_fee_fixed_amount: "0.30",
        },
        agreement: {
          agreement_id: "cag_enterprise",
          marketplace_fee_percentage_bps: 250,
          marketplace_fee_fixed_amount: "0.10",
          payment_fee_percentage_bps: 150,
          payment_fee_fixed_amount: "0.15",
        },
      }),
    });

    const result = await resolver.resolveOrderTerms({
      sellerAccountId: "acc_test",
      amount: "20.00",
      effectiveAt: "2026-04-16T10:00:00.000Z",
    });

    expect(result.marketplaceFeeAmount).toBe("0.60");
    expect(result.paymentFeeAmount).toBe("0.45");
    expect(result.sellerNetAmount).toBe("18.95");
    expect(result.scheduleId).toBe("cts_default");
    expect(result.agreementId).toBe("cag_enterprise");
  });

  it("falls back to the schedule when the account agreement is inactive or out of range", async () => {
    const resolver = createCommercialTermsResolver({
      db: createDb({
        accountType: "business",
        schedule: {
          schedule_id: "cts_default",
          marketplace_fee_percentage_bps: 500,
          marketplace_fee_fixed_amount: "0.25",
          payment_fee_percentage_bps: 300,
          payment_fee_fixed_amount: "0.30",
        },
        agreement: null,
      }),
    });

    const result = await resolver.resolveOrderTerms({
      sellerAccountId: "acc_test",
      amount: "20.00",
      effectiveAt: "2026-04-16T10:00:00.000Z",
    });

    expect(result.scheduleId).toBe("cts_default");
    expect(result.agreementId).toBeNull();
    expect(result.marketplaceFeeAmount).toBe("1.25");
    expect(result.paymentFeeAmount).toBe("0.90");
    expect(result.sellerNetAmount).toBe("17.85");
  });

  it("fails when the account is not active", async () => {
    const resolver = createCommercialTermsResolver({
      db: createDb({
        accountStatus: "suspended",
        schedule: {
          schedule_id: "cts_business",
          marketplace_fee_percentage_bps: 850,
          marketplace_fee_fixed_amount: "0.10",
          payment_fee_percentage_bps: 290,
          payment_fee_fixed_amount: "0.30",
        },
      }),
    });

    await expect(
      resolver.resolveListingTerms({
        sellerAccountId: "acc_test",
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
        sellerAccountId: "acc_test",
        amount: "12.00",
        effectiveAt: "2026-04-16T10:00:00.000Z",
      }),
    ).rejects.toThrow("No active commercial terms were found");
  });
});
