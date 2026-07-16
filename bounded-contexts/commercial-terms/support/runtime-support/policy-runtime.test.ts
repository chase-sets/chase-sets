import { describe, expect, it } from "vitest";
import { getEventCommitMetadata, runWithEventCommitMetadata } from "@chase-sets/event-core/consistency";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { initialPolicyDocumentState } from "@chase-sets/platform-policy/domain";
import {
  buildCommercialTermsPolicyProjectionHandlers,
  createCommercialTermsPolicyRuntime,
  evolveCommercialTermsPolicyDocument,
} from "./policy-runtime";
import type {
  LegacyAgreementCreatedEvent,
  LegacyAgreementRevisedEvent,
  LegacyScheduleCreatedEvent,
  LegacyScheduleRevisedEvent,
} from "./legacy-policy-events";
import { commercialTermsSchedulePolicy } from "./terms-policy";
import { DEFAULT_SHIPPING_ALLOWANCE_PERCENTAGE_BPS } from "./common";

/**
 * Direct coverage of the upcast/dual-handler path: replays pre-convergence
 * event shapes (as they exist, immutably, on real event streams recorded
 * before schedules/agreements moved onto the shared platform-policy
 * machinery) through both the aggregate evolver (used for command-side
 * rehydration) and the projection handlers (used for read-model rebuilds).
 */

const legacyScheduleCreated: LegacyScheduleCreatedEvent = {
  type: "commercial-terms.schedule.created",
  data: {
    scheduleId: "cts_business",
    label: "Business",
    accountType: "business",
    marketplaceSalesFeePercentageBps: 850,
    marketplaceSalesFeeFixedAmount: "0.10",
    shippingAllowancePercentageBps: 500,
    status: "active",
    effectiveFrom: "2026-01-01T00:00:00.000Z",
    effectiveUntil: null,
    createdByUserId: "usr_admin",
  },
};

const legacyScheduleRevised: LegacyScheduleRevisedEvent = {
  type: "commercial-terms.schedule.revised",
  data: {
    scheduleId: "cts_business",
    label: "Business revised",
    marketplaceSalesFeePercentageBps: 650,
    marketplaceSalesFeeFixedAmount: "0.05",
    shippingAllowancePercentageBps: 750,
    status: "active",
    effectiveFrom: "2026-05-01T00:00:00.000Z",
    effectiveUntil: null,
    revisedByUserId: "usr_admin",
  },
};

const legacyAgreementCreated: LegacyAgreementCreatedEvent = {
  type: "commercial-terms.agreement.created",
  data: {
    agreementId: "cag_1",
    accountId: "acc_seller",
    label: "Preferred Seller",
    marketplaceSalesFeePercentageBps: 700,
    marketplaceSalesFeeFixedAmount: "0.05",
    shippingAllowancePercentageBps: 500,
    status: "active",
    effectiveFrom: "2026-01-01T00:00:00.000Z",
    effectiveUntil: null,
    createdByUserId: "usr_admin",
  },
};

const legacyAgreementRevised: LegacyAgreementRevisedEvent = {
  type: "commercial-terms.agreement.revised",
  data: {
    agreementId: "cag_1",
    label: "Preferred Seller Renewal",
    marketplaceSalesFeePercentageBps: 600,
    marketplaceSalesFeeFixedAmount: "0.00",
    shippingAllowancePercentageBps: 800,
    status: "active",
    effectiveFrom: "2026-06-01T00:00:00.000Z",
    effectiveUntil: null,
    revisedByUserId: "usr_admin",
  },
};

describe("commercial terms policy command consistency", () => {
  it("records atomic policy-window and document commits for post-write freshness", async () => {
    const { allEvents, eventStore } = createInMemoryEventStore();
    const runtime = createCommercialTermsPolicyRuntime({
      eventStore,
      db: { query: async () => ({ rows: [] }) } as never,
    });

    const metadata = await runWithEventCommitMetadata(async () => {
      await runtime.createScheduleDocument(
        commercialTermsSchedulePolicy("business"),
        {
          value: {
            label: legacyScheduleCreated.data.label,
            accountType: legacyScheduleCreated.data.accountType,
            marketplaceSalesFeePercentageBps: legacyScheduleCreated.data.marketplaceSalesFeePercentageBps,
            marketplaceSalesFeeFixedAmount: legacyScheduleCreated.data.marketplaceSalesFeeFixedAmount,
            shippingAllowancePercentageBps:
              legacyScheduleCreated.data.shippingAllowancePercentageBps ?? DEFAULT_SHIPPING_ALLOWANCE_PERCENTAGE_BPS,
          },
          status: "inactive",
          effectiveFrom: "2027-01-01T00:00:00.000Z",
          effectiveUntil: "2027-12-31T00:00:00.000Z",
          actorUserId: "usr_admin",
        },
        {
          tenantId: "tnt_test" as never,
          audit: {
            performedByUserId: "usr_admin" as never,
            forAccountId: "acc_admin" as never,
          },
        },
      );

      return getEventCommitMetadata();
    });

    expect(allEvents.map((event) => event.eventType)).toEqual([
      "commercial-terms.policy-window.recorded",
      "platform-policy.document.created",
    ]);
    expect(metadata).toEqual({
      eventIds: allEvents.map((event) => event.eventId),
      maxGlobalPosition: allEvents.at(-1)?.globalPosition,
      sources: [
        {
          sourceContextName: "commercial-terms",
          eventIds: allEvents.map((event) => event.eventId),
          maxGlobalPosition: allEvents.at(-1)?.globalPosition,
        },
      ],
    });
  });
});

describe("evolveCommercialTermsPolicyDocument (aggregate replay of legacy events)", () => {
  it("upcasts a legacy schedule created event into the shared policy-document state", () => {
    const state = evolveCommercialTermsPolicyDocument(initialPolicyDocumentState, legacyScheduleCreated);

    expect(state).toMatchObject({
      documentId: "cts_business",
      policyKey: "commercial-terms.schedule.business",
      status: "active",
      value: {
        label: "Business",
        accountType: "business",
        marketplaceSalesFeePercentageBps: 850,
        marketplaceSalesFeeFixedAmount: "0.10",
        shippingAllowancePercentageBps: 500,
      },
    });
  });

  it("carries the account type forward across a legacy schedule revision, which never restates it", () => {
    const created = evolveCommercialTermsPolicyDocument(initialPolicyDocumentState, legacyScheduleCreated);
    const revised = evolveCommercialTermsPolicyDocument(created, legacyScheduleRevised);

    expect(revised).toMatchObject({
      documentId: "cts_business",
      policyKey: "commercial-terms.schedule.business",
      value: {
        label: "Business revised",
        accountType: "business",
        marketplaceSalesFeePercentageBps: 650,
        marketplaceSalesFeeFixedAmount: "0.05",
        shippingAllowancePercentageBps: 750,
      },
    });
  });

  it("carries the account id forward across a legacy agreement revision", () => {
    const created = evolveCommercialTermsPolicyDocument(initialPolicyDocumentState, legacyAgreementCreated);
    const revised = evolveCommercialTermsPolicyDocument(created, legacyAgreementRevised);

    expect(revised).toMatchObject({
      documentId: "cag_1",
      policyKey: "commercial-terms.agreement.acc-seller",
      value: {
        label: "Preferred Seller Renewal",
        accountId: "acc_seller",
        marketplaceSalesFeePercentageBps: 600,
        marketplaceSalesFeeFixedAmount: "0.00",
        shippingAllowancePercentageBps: 800,
      },
    });
  });

  it("accepts a post-convergence platform-policy revision applied on top of legacy history", () => {
    const created = evolveCommercialTermsPolicyDocument(initialPolicyDocumentState, legacyScheduleCreated);
    const converged = evolveCommercialTermsPolicyDocument(created, {
      type: "platform-policy.document.revised",
      data: {
        documentId: "cts_business",
        policyKey: "commercial-terms.schedule.business",
        status: "active",
        value: {
          label: "Business converged",
          accountType: "business",
          marketplaceSalesFeePercentageBps: 600,
          marketplaceSalesFeeFixedAmount: "0.00",
          shippingAllowancePercentageBps: 500,
        },
        effectiveFrom: "2026-07-01T00:00:00.000Z",
        effectiveUntil: null,
        actorUserId: "usr_admin",
      },
    });

    expect(converged).toMatchObject({
      documentId: "cts_business",
      policyKey: "commercial-terms.schedule.business",
      value: { label: "Business converged" },
    });
  });
});

describe("buildCommercialTermsPolicyProjectionHandlers (read-model rebuild of legacy events)", () => {
  function createDbSpy(existingRow?: Readonly<{ value: unknown; policy_key: string }>) {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const db = {
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params: params ?? [] });
        if (sql.includes("SELECT value, policy_key FROM platform_policy_documents")) {
          return { rows: existingRow ? [existingRow] : [] };
        }
        return { rows: [] };
      },
    };
    return { db: db as never, calls };
  }

  function transportEvent<TData>(id: string, data: TData) {
    return {
      id,
      data,
      timing: { recordedAt: "2026-05-01T00:00:01.000Z" },
      audit: { performedByUserId: "usr_replay", forAccountId: "acc_admin" },
    };
  }

  it("upserts a platform_policy_documents row for a legacy schedule created event", async () => {
    const { db, calls } = createDbSpy();
    const handlers = buildCommercialTermsPolicyProjectionHandlers(db);

    await handlers["commercial-terms.schedule.created"]?.(transportEvent("evt_1", legacyScheduleCreated.data) as never);

    const insert = calls.find((call) => call.sql.includes("INSERT INTO platform_policy_documents"));
    expect(insert).toBeDefined();
    expect(insert?.params).toContain("commercial-terms.schedule.business");
    expect(insert?.params).toContain("cts_business");
  });

  it("merges the prior account type forward when projecting a legacy schedule revised event", async () => {
    const { db, calls } = createDbSpy({
      policy_key: "commercial-terms.schedule.business",
      value: {
        label: "Business",
        accountType: "business",
        marketplaceSalesFeePercentageBps: 850,
        marketplaceSalesFeeFixedAmount: "0.10",
        shippingAllowancePercentageBps: 500,
      },
    });
    const handlers = buildCommercialTermsPolicyProjectionHandlers(db);

    await handlers["commercial-terms.schedule.revised"]?.(transportEvent("evt_2", legacyScheduleRevised.data) as never);

    const update = calls.find((call) => call.sql.includes("UPDATE platform_policy_documents"));
    expect(update).toBeDefined();
    const updatedValue = JSON.parse(String(update?.params[2]));
    expect(updatedValue).toMatchObject({ accountType: "business", label: "Business revised" });
  });

  it("throws when a legacy schedule revised event arrives before its creation has been projected", async () => {
    const { db } = createDbSpy();
    const handlers = buildCommercialTermsPolicyProjectionHandlers(db);

    await expect(
      handlers["commercial-terms.schedule.revised"]?.(transportEvent("evt_3", legacyScheduleRevised.data) as never),
    ).rejects.toThrow("before its creation has been projected");
  });

  it("upserts a platform_policy_documents row for a legacy agreement created event", async () => {
    const { db, calls } = createDbSpy();
    const handlers = buildCommercialTermsPolicyProjectionHandlers(db);

    await handlers["commercial-terms.agreement.created"]?.(
      transportEvent("evt_4", legacyAgreementCreated.data) as never,
    );

    const insert = calls.find((call) => call.sql.includes("INSERT INTO platform_policy_documents"));
    expect(insert?.params).toContain("commercial-terms.agreement.acc-seller");
  });

  it("merges the prior account id forward when projecting a legacy agreement revised event", async () => {
    const { db, calls } = createDbSpy({
      policy_key: "commercial-terms.agreement.acc-seller",
      value: {
        label: "Preferred Seller",
        accountId: "acc_seller",
        marketplaceSalesFeePercentageBps: 700,
        marketplaceSalesFeeFixedAmount: "0.05",
        shippingAllowancePercentageBps: 500,
      },
    });
    const handlers = buildCommercialTermsPolicyProjectionHandlers(db);

    await handlers["commercial-terms.agreement.revised"]?.(
      transportEvent("evt_5", legacyAgreementRevised.data) as never,
    );

    const update = calls.find((call) => call.sql.includes("UPDATE platform_policy_documents"));
    const updatedValue = JSON.parse(String(update?.params[2]));
    expect(updatedValue).toMatchObject({ accountId: "acc_seller", label: "Preferred Seller Renewal" });
  });
});
