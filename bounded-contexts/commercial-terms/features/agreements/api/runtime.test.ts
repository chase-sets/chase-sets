import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type {
  AppendToStreamInput,
  GlobalPosition,
  ReadAllInput,
  ReadStreamInput,
  StoredEvent,
} from "@chase-sets/event-core/storage";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import { createCommercialTermsPolicyRuntime } from "../../../support/runtime-support/policy-runtime";
import { createAgreementRuntime } from "./runtime";

const context = {
  tenantId: "tnt_test" as never,
  audit: {
    performedByUserId: "usr_admin" as never,
    forAccountId: "acc_admin" as never,
  },
};

describe("commercial terms agreement runtime", () => {
  it("rejects malformed account ids before account existence resolution or writes", async () => {
    const { allEvents, eventStore } = createInMemoryEventStore();
    const db = {
      query: vi.fn(async () => ({ rows: [] })),
    };
    const policies = createCommercialTermsPolicyRuntime({ eventStore, db: db as never });
    const runtime = createAgreementRuntime({ policies, db: db as never });

    await expect(
      runtime.createAgreement(
        {
          label: "Preferred",
          accountId: "seller_missing",
          marketplaceSalesFeePercentageBps: 550,
          marketplaceSalesFeeFixedAmount: "0.00",
          shippingAllowancePercentageBps: 700,
          status: "active",
          effectiveFrom: "2026-05-01T00:00:00.000Z",
          effectiveUntil: null,
          createdByUserId: "usr_admin",
        },
        context,
      ),
    ).rejects.toThrow("Account ID must start with acc_.");
    expect(db.query).not.toHaveBeenCalled();
    expect(allEvents).toHaveLength(0);
  });

  it("rejects agreement creation for accounts that are not available in commercial terms", async () => {
    const { allEvents, eventStore } = createInMemoryEventStore();
    const db = {
      query: vi.fn(async () => ({ rows: [] })),
    };
    const policies = createCommercialTermsPolicyRuntime({ eventStore, db: db as never });
    const runtime = createAgreementRuntime({ policies, db: db as never });

    await expect(
      runtime.createAgreement(
        {
          label: "Preferred",
          accountId: "acc_missing",
          marketplaceSalesFeePercentageBps: 550,
          marketplaceSalesFeeFixedAmount: "0.00",
          shippingAllowancePercentageBps: 700,
          status: "active",
          effectiveFrom: "2026-05-01T00:00:00.000Z",
          effectiveUntil: null,
          createdByUserId: "usr_admin",
        },
        context,
      ),
    ).rejects.toThrow("Account acc_missing is not available for commercial terms.");
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("FROM commercial_terms_account_pages"), [
      "acc_missing",
    ]);
    expect(allEvents).toHaveLength(0);
  });

  it("rejects active agreement revisions with overlapping windows while excluding the current agreement", async () => {
    const queryParams: (readonly unknown[])[] = [];
    const { allEvents, eventStore } = createInMemoryEventStore();
    const db = {
      query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
        queryParams.push(params ?? []);
        if (sql.includes("FROM platform_policy_document_history")) {
          return { rows: [] };
        }
        if (sql.includes("WHERE agreement.document_id = $1")) {
          return {
            rows: [
              {
                agreement_id: "cag_current",
                account_id: "acc_seller",
                account_display_name: "Seller",
                account_type: "business",
                label: "Preferred",
                marketplace_sales_fee_percentage_bps: 700,
                marketplace_sales_fee_fixed_amount: "0.05",
                shipping_allowance_percentage_bps: 500,
                status: "active",
                effective_from: "2026-01-01T00:00:00.000Z",
                effective_until: null,
                created_at: "2026-01-01T00:00:00.000Z",
                updated_at: "2026-01-01T00:00:00.000Z",
              },
            ],
          };
        }
        if (sql.includes("FROM commercial_terms_account_pages")) {
          return { rows: [{ account_id: "acc_seller" }] };
        }
        if (sql.includes("tstzrange")) {
          return { rows: [{ document_id: "cag_existing" }] };
        }

        return { rows: [] };
      }),
    };
    const policies = createCommercialTermsPolicyRuntime({ eventStore, db: db as never });
    const runtime = createAgreementRuntime({ policies, db: db as never });

    await expect(
      runtime.reviseAgreement(
        "cag_current",
        {
          label: "Preferred Renewal",
          marketplaceSalesFeePercentageBps: 600,
          marketplaceSalesFeeFixedAmount: "0.00",
          shippingAllowancePercentageBps: 800,
          status: "active",
          effectiveFrom: "2026-05-01T00:00:00.000Z",
          effectiveUntil: "2027-05-01T00:00:00.000Z",
          revisedByUserId: "usr_admin",
        },
        context,
      ),
    ).rejects.toThrow("Active agreement cag_existing already covers that account and effective window.");
    expect(queryParams).toContainEqual([
      "commercial-terms.agreement.acc-seller",
      "2026-05-01T00:00:00.000Z",
      "2027-05-01T00:00:00.000Z",
      "cag_current",
    ]);
    expect(allEvents).toHaveLength(0);
  });
});
