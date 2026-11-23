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
import { buildFoundersWindowReactionHandlers } from "../integrations/identity/founders-window-reaction";
import { createAgreementRuntime } from "./runtime";

const context = {
  tenantId: "tnt_test" as never,
  audit: {
    performedByUserId: "usr_admin" as never,
    forAccountId: "acc_admin" as never,
  },
};

describe("commercial terms agreement runtime", () => {
  it("propagates account name, display name and id through list, detail and options", async () => {
    const identity = {
      account_id: "acc_demo",
      account_name: "Demo Account",
      account_display_name: "Chase Sets",
      account_type: "business",
    };
    const option = {
      account_id: identity.account_id,
      account_name: identity.account_name,
      display_name: identity.account_display_name,
      account_type: identity.account_type,
    };
    const { eventStore } = createInMemoryEventStore();
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("COUNT(*)")) return { rows: [{ count: "1" }] };
        if (sql.includes("FROM platform_policy_document_history")) return { rows: [] };
        if (sql.includes("FROM platform_policy_documents AS agreement"))
          return { rows: [{ agreement_id: "cag_demo", ...identity }] };
        if (sql.includes("FROM commercial_terms_account_pages")) return { rows: [option] };
        return { rows: [] };
      }),
    };
    const policies = createCommercialTermsPolicyRuntime({ eventStore, db: db as never });
    const runtime = createAgreementRuntime({ policies, db: db as never });
    expect(await runtime.listAgreements({})).toMatchObject({ items: [identity], total: 1 });
    expect(await runtime.getAgreement("cag_demo")).toMatchObject({ ...identity, history: [] });
    expect(await runtime.listAccountOptions()).toEqual([option]);
  });
  it("allows exactly one of two concurrent overlapping agreement creates for the same account", async () => {
    const { allEvents, eventStore } = createInMemoryEventStore();
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM commercial_terms_account_pages")) {
          return { rows: [{ account_id: "acc_seller" }] };
        }
        if (sql.includes("tstzrange")) {
          return { rows: [] };
        }
        return { rows: [] };
      }),
    };
    const policies = createCommercialTermsPolicyRuntime({ eventStore, db: db as never });
    const runtime = createAgreementRuntime({ policies, db: db as never });
    const create = (agreementId: string) =>
      runtime.createAgreement(
        {
          agreementId,
          label: "Preferred",
          accountId: "acc_seller",
          marketplaceSalesFeePercentageBps: 550,
          marketplaceSalesFeeFixedAmount: "0.00",
          shippingAllowancePercentageBps: 700,
          status: "active",
          effectiveFrom: "2026-05-01T00:00:00.000Z",
          effectiveUntil: "2027-05-01T00:00:00.000Z",
          createdByUserId: "usr_admin",
        },
        context,
      );

    const results = await Promise.allSettled([create("cag_concurrent_1"), create("cag_concurrent_2")]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(rejected?.reason).toBeInstanceOf(Error);
    expect((rejected?.reason as Error).message).toMatch(
      /Active agreement cag_concurrent_[12] already covers that account and effective window\./,
    );
    expect(allEvents.filter((event) => event.eventType === "platform-policy.document.created")).toHaveLength(1);
  });

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

describe("commercial terms agreement Shipping Allowance", () => {
  const ALLOWANCE_KEY = "shippingAllowancePercentageBps";

  function createAgreementHarness() {
    const { allEvents, eventStore } = createInMemoryEventStore();
    const db = {
      query: vi.fn(async (sql: string, params?: readonly unknown[]) => {
        if (sql.includes("FROM platform_policy_document_history")) return { rows: [] };
        if (sql.includes("WHERE agreement.document_id = $1")) {
          return { rows: [{ agreement_id: params?.[0], account_id: "acc_seller" }] };
        }
        if (sql.includes("FROM commercial_terms_account_pages")) return { rows: [{ account_id: "acc_seller" }] };
        return { rows: [] };
      }),
    };
    const policies = createCommercialTermsPolicyRuntime({ eventStore, db: db as never });
    const runtime = createAgreementRuntime({ policies, db: db as never });
    const storedValues = (eventType: string) =>
      allEvents
        .filter((event) => event.eventType === eventType)
        .map((event) => (event.payload as { value: Record<string, unknown> }).value);
    return { runtime, storedValues };
  }

  const terms = {
    label: "Preferred",
    marketplaceSalesFeePercentageBps: 550,
    marketplaceSalesFeeFixedAmount: "0.00",
    status: "active",
    effectiveFrom: "2026-05-01T00:00:00.000Z",
    effectiveUntil: null,
  } as const;
  const storedTerms = {
    label: "Preferred",
    accountId: "acc_seller",
    marketplaceSalesFeePercentageBps: 550,
    marketplaceSalesFeeFixedAmount: "0.00",
  };

  it("stores no Shipping Allowance key when an agreement is created or revised without one", async () => {
    const { runtime, storedValues } = createAgreementHarness();

    await runtime.createAgreement(
      { ...terms, agreementId: "cag_follows", accountId: "acc_seller", createdByUserId: "usr_admin" },
      context,
    );
    await runtime.reviseAgreement("cag_follows", { ...terms, label: "Renewed", revisedByUserId: "usr_admin" }, context);

    const [created] = storedValues("platform-policy.document.created");
    const [revised] = storedValues("platform-policy.document.revised");
    expect(created).toStrictEqual(storedTerms);
    expect(Object.keys(created!)).not.toContain(ALLOWANCE_KEY);
    expect(revised).toStrictEqual({ ...storedTerms, label: "Renewed" });
    expect(Object.keys(revised!)).not.toContain(ALLOWANCE_KEY);
  });

  it("stores the stated Shipping Allowance on create and revise, including zero", async () => {
    const { runtime, storedValues } = createAgreementHarness();

    await runtime.createAgreement(
      {
        ...terms,
        agreementId: "cag_stated",
        accountId: "acc_seller",
        shippingAllowancePercentageBps: 700,
        createdByUserId: "usr_admin",
      },
      context,
    );
    await runtime.reviseAgreement(
      "cag_stated",
      { ...terms, shippingAllowancePercentageBps: 0, revisedByUserId: "usr_admin" },
      context,
    );

    expect(storedValues("platform-policy.document.created")).toStrictEqual([{ ...storedTerms, [ALLOWANCE_KEY]: 700 }]);
    expect(storedValues("platform-policy.document.revised")).toStrictEqual([{ ...storedTerms, [ALLOWANCE_KEY]: 0 }]);
  });

  it("drops a pinned Shipping Allowance when a revision states none", async () => {
    const { runtime, storedValues } = createAgreementHarness();

    await runtime.createAgreement(
      {
        ...terms,
        agreementId: "cag_unpinned",
        accountId: "acc_seller",
        shippingAllowancePercentageBps: 700,
        createdByUserId: "usr_admin",
      },
      context,
    );
    await runtime.reviseAgreement("cag_unpinned", { ...terms, revisedByUserId: "usr_admin" }, context);

    expect(storedValues("platform-policy.document.revised")).toStrictEqual([storedTerms]);
  });

  it("stores the founders window agreement without a Shipping Allowance", async () => {
    const { runtime, storedValues } = createAgreementHarness();
    const handlers = buildFoundersWindowReactionHandlers(runtime);

    await handlers["identity.account.founders-window-opened"]!({
      streamId: "identity.account-acc_seller",
      tenantId: context.tenantId,
      audit: context.audit,
      trace: {},
      timing: { occurredAt: "2026-07-01T00:00:00.000Z", recordedAt: "2026-07-01T00:00:01.000Z" },
      data: {
        betaAccessStartedAt: "2026-07-01T00:00:00.000Z",
        foundersWindowEndsAt: "2026-08-30T00:00:00.000Z",
      },
    } as never);

    const [founders] = storedValues("platform-policy.document.created");
    expect(founders).toStrictEqual({
      label: "Founders window",
      accountId: "acc_seller",
      marketplaceSalesFeePercentageBps: 0,
      marketplaceSalesFeeFixedAmount: "0.00",
    });
    expect(Object.keys(founders!)).not.toContain(ALLOWANCE_KEY);
  });
});
