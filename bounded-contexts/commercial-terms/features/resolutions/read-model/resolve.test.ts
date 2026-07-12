import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { registerPostWriteConsistencyRecorder } from "@chase-sets/platform-runtime/post-write-consistency";
import { createCommercialTermsResolver, quoteLockedMarketplaceFeeTerms, resolveStandardScheduleTerms } from "./resolve";

const accountSourceTelemetryBase = {
  boundedContextName: "commercial-terms",
  sourceContextName: "identity",
  projectionName: "commercial-terms-account-projection",
  readModelTable: "commercial_terms_account_pages",
  fallbackId: "commercial-terms.identity-account-source-fresh-account",
  fallbackCategory: "host-owned bridge",
  surface: "commercial-terms-resolution",
  strategy: "projection-fallback",
} as const;

const accountSourceTelemetryRecorder = vi.fn();
let unregisterAccountSourceTelemetryRecorder: (() => void) | null = null;

describe("locked marketplace fee terms", () => {
  it("requotes a changed price from the recorded formula and cap", () => {
    expect(
      quoteLockedMarketplaceFeeTerms(
        {
          marketplaceSalesFeePercentageBps: 500,
          marketplaceSalesFeeFixedAmount: "0.00",
          marketplaceSalesFeeCapAmount: "25.00",
        },
        "1000.00",
      ),
    ).toEqual({
      basisAmount: "1000.00",
      marketplaceSalesFeeUnitAmount: "25.00",
      sellerNetUnitAmount: "975.00",
    });
  });

  it("treats a locked zero-percent agreement exactly like any other rate", () => {
    expect(
      quoteLockedMarketplaceFeeTerms(
        {
          marketplaceSalesFeePercentageBps: 0,
          marketplaceSalesFeeFixedAmount: "0.00",
          marketplaceSalesFeeCapAmount: null,
        },
        "350.00",
      ),
    ).toMatchObject({ marketplaceSalesFeeUnitAmount: "0.00", sellerNetUnitAmount: "350.00" });
  });
});

function createDb(
  options: Readonly<{
    accountType?: "personal" | "business" | "enterprise";
    accountStatus?: string;
    accountMissing?: boolean;
    schedule?: {
      schedule_id: string;
      marketplace_sales_fee_percentage_bps: number;
      marketplace_sales_fee_fixed_amount: string;
      marketplace_sales_fee_cap_amount?: string;
      shipping_allowance_percentage_bps?: number;
    } | null;
    agreement?: {
      agreement_id: string;
      marketplace_sales_fee_percentage_bps: number;
      marketplace_sales_fee_fixed_amount: string;
      shipping_allowance_percentage_bps?: number;
    } | null;
  }>,
): PgQueryable {
  return {
    query: async <TRow>(sql: string, params?: readonly unknown[]) => {
      if (sql.includes("FROM commercial_terms_account_pages")) {
        return {
          rows: options.accountMissing
            ? []
            : ([
                {
                  account_id: "acc_test",
                  account_type: options.accountType ?? "business",
                  status: options.accountStatus ?? "active",
                },
              ] as TRow[]),
        };
      }

      if (sql.includes("FROM platform_policy_documents")) {
        const policyKey = String(params?.[0] ?? "");
        if (policyKey === "commercial-terms.marketplace-sales-fee-schedule") {
          return {
            rows: options.schedule
              ? [
                  {
                    ...options.schedule,
                    marketplace_sales_fee_cap_amount: options.schedule.marketplace_sales_fee_cap_amount ?? "10000.00",
                  } as TRow,
                ]
              : [],
          };
        }
        if (policyKey.startsWith("commercial-terms.agreement.")) {
          return { rows: options.agreement ? [options.agreement as TRow] : [] };
        }
      }

      throw new Error(`Unexpected SQL: ${sql}`);
    },
  } as PgQueryable;
}

function createPublicStandardDb(
  options: Readonly<{
    schedule?: {
      schedule_id: string;
      label: string;
      marketplace_sales_fee_percentage_bps: number;
      marketplace_sales_fee_fixed_amount: string;
      marketplace_sales_fee_cap_amount?: string;
      shipping_allowance_percentage_bps?: number;
      updated_at?: string;
    } | null;
    queries?: string[];
  }>,
): PgQueryable {
  return {
    query: async <TRow>(sql: string, params?: readonly unknown[]) => {
      options.queries?.push(sql);

      if (
        sql.includes("FROM platform_policy_documents") &&
        String(params?.[0] ?? "") === "commercial-terms.marketplace-sales-fee-schedule"
      ) {
        return {
          rows: options.schedule
            ? [
                {
                  schedule_id: options.schedule.schedule_id,
                  label: options.schedule.label,
                  marketplace_sales_fee_percentage_bps: options.schedule.marketplace_sales_fee_percentage_bps,
                  marketplace_sales_fee_fixed_amount: options.schedule.marketplace_sales_fee_fixed_amount,
                  marketplace_sales_fee_cap_amount: options.schedule.marketplace_sales_fee_cap_amount ?? "10000.00",
                  shipping_allowance_percentage_bps: options.schedule.shipping_allowance_percentage_bps ?? 500,
                  updated_at: options.schedule.updated_at ?? "2026-04-16T10:00:00.000Z",
                } as TRow,
              ]
            : [],
        };
      }

      throw new Error(`Unexpected SQL: ${sql}`);
    },
  } as PgQueryable;
}

describe("commercial terms resolver", () => {
  beforeEach(() => {
    accountSourceTelemetryRecorder.mockReset();
    unregisterAccountSourceTelemetryRecorder = registerPostWriteConsistencyRecorder(accountSourceTelemetryRecorder);
  });

  afterEach(() => {
    unregisterAccountSourceTelemetryRecorder?.();
    unregisterAccountSourceTelemetryRecorder = null;
  });

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
    expect(accountSourceTelemetryRecorder).toHaveBeenCalledWith({
      ...accountSourceTelemetryBase,
      outcome: "projection_hit",
    });
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

  it("uses the host account source when the commercial terms account projection has not caught up", async () => {
    const resolver = createCommercialTermsResolver({
      db: createDb({
        accountMissing: true,
        schedule: {
          schedule_id: "cts_personal",
          marketplace_sales_fee_percentage_bps: 900,
          marketplace_sales_fee_fixed_amount: "0.15",
        },
      }),
      accountSource: {
        getAccount: async (accountId) => ({
          account_id: accountId,
          account_type: "personal",
          status: "active",
        }),
      },
    });

    const result = await resolver.resolveListingTerms({
      accountId: "acc_fresh",
      amount: "10.00",
      effectiveAt: "2026-04-16T10:00:00.000Z",
    });

    expect(result.accountId).toBe("acc_fresh");
    expect(result.accountType).toBe("personal");
    expect(result.marketplaceSalesFeeUnitAmount).toBe("1.05");
    expect(result.scheduleId).toBe("cts_personal");
    expect(accountSourceTelemetryRecorder).toHaveBeenCalledWith({
      ...accountSourceTelemetryBase,
      outcome: "fallback_used",
    });
  });

  it("records a fallback failure when the host account source is missing the account", async () => {
    const resolver = createCommercialTermsResolver({
      db: createDb({
        accountMissing: true,
        schedule: {
          schedule_id: "cts_personal",
          marketplace_sales_fee_percentage_bps: 900,
          marketplace_sales_fee_fixed_amount: "0.15",
        },
      }),
      accountSource: {
        getAccount: async () => null,
      },
    });

    await expect(
      resolver.resolveListingTerms({
        accountId: "acc_fresh",
        amount: "10.00",
        effectiveAt: "2026-04-16T10:00:00.000Z",
      }),
    ).rejects.toThrow("is not available for commercial terms");

    expect(accountSourceTelemetryRecorder).toHaveBeenCalledWith({
      ...accountSourceTelemetryBase,
      outcome: "fallback_failed",
    });
  });

  it("records a fallback failure when the host account source returns an inactive account", async () => {
    const resolver = createCommercialTermsResolver({
      db: createDb({
        accountMissing: true,
        schedule: {
          schedule_id: "cts_personal",
          marketplace_sales_fee_percentage_bps: 900,
          marketplace_sales_fee_fixed_amount: "0.15",
        },
      }),
      accountSource: {
        getAccount: async (accountId) => ({
          account_id: accountId,
          account_type: "personal",
          status: "suspended",
        }),
      },
    });

    await expect(
      resolver.resolveListingTerms({
        accountId: "acc_fresh",
        amount: "10.00",
        effectiveAt: "2026-04-16T10:00:00.000Z",
      }),
    ).rejects.toThrow("is not active");

    expect(accountSourceTelemetryRecorder).toHaveBeenCalledWith({
      ...accountSourceTelemetryBase,
      outcome: "fallback_failed",
    });
  });

  it("records a fallback failure when the host account source omits the account type", async () => {
    const resolver = createCommercialTermsResolver({
      db: createDb({
        accountMissing: true,
        schedule: {
          schedule_id: "cts_personal",
          marketplace_sales_fee_percentage_bps: 900,
          marketplace_sales_fee_fixed_amount: "0.15",
        },
      }),
      accountSource: {
        getAccount: async (accountId) =>
          ({
            account_id: accountId,
            status: "active",
          }) as never,
      },
    });

    await expect(
      resolver.resolveListingTerms({
        accountId: "acc_fresh",
        amount: "10.00",
        effectiveAt: "2026-04-16T10:00:00.000Z",
      }),
    ).rejects.toThrow("is missing account type");

    expect(accountSourceTelemetryRecorder).toHaveBeenCalledWith({
      ...accountSourceTelemetryBase,
      outcome: "fallback_failed",
    });
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

  it("does not overcharge exact-cent low-value marketplace sales fees", async () => {
    const resolver = createCommercialTermsResolver({
      db: createDb({
        schedule: {
          schedule_id: "cts_low_value",
          marketplace_sales_fee_percentage_bps: 1000,
          marketplace_sales_fee_fixed_amount: "0.00",
        },
      }),
    });

    const result = await resolver.resolveListingTerms({
      accountId: "acc_test",
      amount: "0.10",
      effectiveAt: "2026-04-16T10:00:00.000Z",
    });

    expect(result.marketplaceSalesFeeUnitAmount).toBe("0.01");
    expect(result.sellerNetUnitAmount).toBe("0.09");
  });

  it("resolves public standard listing terms from the personal default schedule without an account", async () => {
    const queries: string[] = [];
    const resolver = createCommercialTermsResolver({
      db: createPublicStandardDb({
        queries,
        schedule: {
          schedule_id: "cts_seed_personal_default",
          label: "Personal Default",
          marketplace_sales_fee_percentage_bps: 900,
          marketplace_sales_fee_fixed_amount: "0.15",
          shipping_allowance_percentage_bps: 500,
          updated_at: "2026-04-16T10:00:00.000Z",
        },
      }),
    });

    const result = await resolver.resolvePublicStandardListingTerms({
      amount: "380.00",
      effectiveAt: "2026-05-05T16:36:36.000Z",
    });

    expect(result).toMatchObject({
      accountType: "personal",
      basisAmount: "380.00",
      marketplaceSalesFeeUnitAmount: "34.35",
      sellerNetUnitAmount: "345.65",
      shippingAllowancePercentageBps: 500,
      scheduleId: "cts_seed_personal_default",
      scheduleLabel: "Personal Default",
      scheduleUpdatedAt: "2026-04-16T10:00:00.000Z",
      resolvedAt: "2026-05-05T16:36:36.000Z",
    });
    expect(queries.some((sql) => sql.includes("commercial_terms_account_pages"))).toBe(false);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("FROM platform_policy_documents");
  });

  it("rounds public standard fee previews with the Commercial Terms formula", async () => {
    const resolver = createCommercialTermsResolver({
      db: createPublicStandardDb({
        schedule: {
          schedule_id: "cts_low_value",
          label: "Low Value",
          marketplace_sales_fee_percentage_bps: 500,
          marketplace_sales_fee_fixed_amount: "0.00",
        },
      }),
    });

    const result = await resolver.resolvePublicStandardListingTerms({
      amount: "0.02",
      effectiveAt: "2026-04-16T10:00:00.000Z",
    });

    expect(result.marketplaceSalesFeeUnitAmount).toBe("0.01");
    expect(result.sellerNetUnitAmount).toBe("0.01");
  });

  it("resolveStandardScheduleTerms returns the raw published percentage/fixed terms for the offer-economics monitor (#4075)", async () => {
    const queries: string[] = [];
    const db = createPublicStandardDb({
      queries,
      schedule: {
        schedule_id: "cts_seed_personal_default",
        label: "Personal Default",
        marketplace_sales_fee_percentage_bps: 900,
        marketplace_sales_fee_fixed_amount: "0.15",
        shipping_allowance_percentage_bps: 500,
        updated_at: "2026-04-16T10:00:00.000Z",
      },
    });

    const result = await resolveStandardScheduleTerms(db, {
      accountType: "personal",
      effectiveAt: "2026-05-05T16:36:36.000Z",
    });

    expect(result).toEqual({
      accountType: "personal",
      marketplaceSalesFeePercentageBps: 900,
      marketplaceSalesFeeFixedAmount: "0.15",
      scheduleId: "cts_seed_personal_default",
      scheduleLabel: "Personal Default",
      resolvedAt: "2026-05-05T16:36:36.000Z",
    });
    expect(queries).toHaveLength(1);
  });

  it("resolveStandardScheduleTerms degrades to zero terms (never throws) when no schedule is published yet", async () => {
    const db = createPublicStandardDb({ schedule: null });

    const result = await resolveStandardScheduleTerms(db, { accountType: "business" });

    expect(result).toMatchObject({
      accountType: "business",
      marketplaceSalesFeePercentageBps: 0,
      marketplaceSalesFeeFixedAmount: "0.00",
      scheduleId: null,
      scheduleLabel: null,
    });
  });

  it("fails closed when public standard terms have no active schedule", async () => {
    const resolver = createCommercialTermsResolver({
      db: createPublicStandardDb({
        schedule: null,
      }),
    });

    await expect(
      resolver.resolvePublicStandardListingTerms({
        amount: "12.00",
        effectiveAt: "2026-04-16T10:00:00.000Z",
      }),
    ).rejects.toThrow("No active published marketplace sales fee schedule was found");
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

describe("commercial terms listing-terms session (m113 #4327 per-account terms session)", () => {
  it("resolves the account's schedule and agreement once and exposes them as the session identity", async () => {
    const resolver = createCommercialTermsResolver({
      db: createDb({
        accountType: "business",
        schedule: {
          schedule_id: "cts_business",
          marketplace_sales_fee_percentage_bps: 850,
          marketplace_sales_fee_fixed_amount: "0.10",
        },
        agreement: {
          agreement_id: "cag_business",
          marketplace_sales_fee_percentage_bps: 700,
          marketplace_sales_fee_fixed_amount: "0.05",
          shipping_allowance_percentage_bps: 600,
        },
      }),
    });

    const session = await resolver.openListingTermsSession({
      accountId: "acc_test",
      effectiveAt: "2026-04-16T10:00:00.000Z",
    });

    expect(session.accountId).toBe("acc_test");
    expect(session.accountType).toBe("business");
    expect(session.scheduleId).toBe("cts_business");
    expect(session.agreementId).toBe("cag_business");
    expect(session.resolvedAt).toBe("2026-04-16T10:00:00.000Z");
  });

  it("quotes byte-identical results to resolveListingTerms across a range of prices, including rounding edges", async () => {
    const db = createDb({
      accountType: "business",
      schedule: {
        schedule_id: "cts_business",
        marketplace_sales_fee_percentage_bps: 733,
        marketplace_sales_fee_fixed_amount: "0.11",
      },
    });
    const resolver = createCommercialTermsResolver({ db });

    const session = await resolver.openListingTermsSession({
      accountId: "acc_test",
      effectiveAt: "2026-04-16T10:00:00.000Z",
    });

    const amounts = ["0.01", "0.02", "0.10", "0.99", "1.00", "9.99", "10.00", "20.00", "199.99", "1000.00"];

    for (const amount of amounts) {
      const individual = await resolver.resolveListingTerms({
        accountId: "acc_test",
        amount,
        effectiveAt: "2026-04-16T10:00:00.000Z",
      });
      const sessionQuote = session.quote(amount);

      expect(sessionQuote).toEqual(individual);
    }
  });

  it("fails closed opening a session when no active schedule or agreement exists", async () => {
    const resolver = createCommercialTermsResolver({
      db: createDb({ schedule: null, agreement: null }),
    });

    await expect(
      resolver.openListingTermsSession({
        accountId: "acc_test",
        effectiveAt: "2026-04-16T10:00:00.000Z",
      }),
    ).rejects.toThrow("No active commercial terms were found");
  });

  it("reflects a schedule revision the next time a session is opened -- the mid-run staleness signal bulk callers key on", async () => {
    let scheduleId = "cts_before_revision";
    let percentageBps = 500;
    const db: PgQueryable = {
      query: async <TRow>(sql: string, params?: readonly unknown[]) => {
        if (sql.includes("FROM commercial_terms_account_pages")) {
          return { rows: [{ account_id: "acc_test", account_type: "business", status: "active" }] as TRow[] };
        }
        if (sql.includes("FROM platform_policy_documents")) {
          const policyKey = String(params?.[0] ?? "");
          if (policyKey === "commercial-terms.marketplace-sales-fee-schedule") {
            return {
              rows: [
                {
                  schedule_id: scheduleId,
                  marketplace_sales_fee_percentage_bps: percentageBps,
                  marketplace_sales_fee_fixed_amount: "0.10",
                  marketplace_sales_fee_cap_amount: "10000.00",
                  shipping_allowance_percentage_bps: 500,
                },
              ] as TRow[],
            };
          }
          if (policyKey.startsWith("commercial-terms.agreement.")) {
            return { rows: [] as TRow[] };
          }
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      },
    };
    const resolver = createCommercialTermsResolver({ db });

    const firstSession = await resolver.openListingTermsSession({ accountId: "acc_test" });
    expect(firstSession.scheduleId).toBe("cts_before_revision");
    expect(firstSession.quote("20.00").marketplaceSalesFeeUnitAmount).toBe("1.10");

    // A revision lands mid-run: the active schedule document changes.
    scheduleId = "cts_after_revision";
    percentageBps = 900;

    const secondSession = await resolver.openListingTermsSession({ accountId: "acc_test" });
    expect(secondSession.scheduleId).toBe("cts_after_revision");
    expect(secondSession.quote("20.00").marketplaceSalesFeeUnitAmount).toBe("1.90");

    // The first session is a snapshot -- it never silently picks up the revision.
    expect(firstSession.quote("20.00").marketplaceSalesFeeUnitAmount).toBe("1.10");
    expect(firstSession.scheduleId).not.toBe(secondSession.scheduleId);
  });
});
