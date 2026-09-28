import { describe, expect, it } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { toTransportEvent } from "@chase-sets/event-core/transport";
import { createPricingAuthorityObservations } from "./listing-authority-observations";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  createListingAuthorityFence,
  prepareListingStandingAuthority,
} from "@chase-sets/platform-runtime/listing-authority-fence";
import {
  listingAuthorityConformance,
  listingAuthorityOwnerConformance,
  type ListingAuthorityOwnerProofs,
} from "@chase-sets/platform-runtime/listing-authority-conformance";
import { createRepricingPolicyRuntime } from "../../repricing-policies/api/runtime";
import type { RepricingRule } from "../../repricing-policies/domain/domain";
import { createPricingListingAuthority, type PricingEvaluationBudget } from "./listing-authority";

const rules: readonly RepricingRule[] = [
  {
    conditions: [],
    directive: {
      currencyCode: "USD",
      anchorChain: [{ source: "market-estimate" }],
      offset: { mode: "absolute", amount: "0.00" },
      floor: { mode: "absolute", amount: "1.00" },
      ceiling: null,
      tolerance: { mode: "absolute", amount: "0.01" },
      rounding: { mode: "none" },
      maxMovePercent: null,
      terminal: { kind: "hold" },
    },
  },
];

// SQL transport is a deterministic owner-data fixture. Policy commands, evaluator,
// decision persistence, invalidation, retained journals and consumer appends are real.
async function fixture() {
  const sourceMemory = createInMemoryEventStore();
  const consumerMemory = createInMemoryEventStore();
  const sourceStore = sourceMemory.eventStore;
  const consumerStore = consumerMemory.eventStore;
  const at = new Date();
  at.setUTCSeconds(0, 0);
  const capturedAt = at.toISOString();
  const policyId = "rpp_synthetic_owner";
  const context: EventStoreContext = {
    tenantId: "tnt_synthetic_pricing",
    audit: { forAccountId: "acc_synthetic_owner", performedByUserId: "usr_pricing_system" },
    listingAuthorityPrincipal: {
      tenantId: "tnt_synthetic_pricing",
      accountId: "acc_synthetic_owner",
      userId: "usr_pricing_system",
      kind: "standing-system",
      admittingOwner: "pricing",
      authorityId: policyId,
      authorityRevision: "1",
      scopeCeiling: ["listings.manage"],
      validBefore: new Date(at.getTime() + 3_600_000).toISOString(),
    },
  };
  let blockInvalidation = false;
  const budgetRows = new Map<string, { accountId: string; day: string; status: "reserved" | "released" }>();
  const budget: PricingEvaluationBudget = {
    reserve: async (input) => {
      if (!budgetRows.has(input.evaluationId))
        budgetRows.set(input.evaluationId, { accountId: input.accountId, day: input.day, status: "reserved" });
      return budgetRows.get(input.evaluationId)!.status === "reserved";
    },
    inspect: async (id) => budgetRows.get(id) ?? null,
    release: async (id) => {
      const row = budgetRows.get(id);
      if (row) row.status = "released";
    },
  };
  const db: PgQueryable = {
    query: async <Row>(sql: string) => {
      let rows: unknown[];
      if (sql.includes("SELECT DISTINCT stream_id FROM event_store_events"))
        rows = [...sourceMemory.streams]
          .filter(
            ([, history]) =>
              history[0]?.eventType === "pricing.repricing-policy.created" ||
              history[0]?.eventType === "platform-policy.document.created",
          )
          .map(([stream_id]) => ({ stream_id }));
      else if (sql.includes("AS source_stream_id"))
        rows = [...sourceMemory.streams.values()]
          .flat()
          .filter(
            (event) =>
              event.eventType === "pricing.evaluation-input.observed" &&
              (event.payload.event as { type?: string }).type === "marketplace.listing.created",
          )
          .map((event) => ({ source_stream_id: (event.payload.event as { streamId: string }).streamId }));
      else if (sql.includes("SELECT listing.listing_id, COALESCE")) rows = [];
      else if (sql.includes("policy.updated_at::text"))
        rows = [
          {
            listing_id: "lst_synthetic_owner",
            seller_account_id: context.audit.forAccountId,
            inventory_item_id: "inv_synthetic_owner",
            catalog_catalog_item_id: "cat_synthetic_owner",
            product_id: "cat_synthetic_owner::",
            price_amount: "10.00",
            price_currency_code: "USD",
            quantity_cap: 1,
            last_stream_version: 1,
            status: "active",
            pause_reason: null,
            grading: "raw",
            created_at: capturedAt,
            category_ids: [],
            acquisition_cost_amount: null,
            acquisition_cost_currency_code: null,
            policy_id: policyId,
            policy_revision: capturedAt,
            rules,
            max_changes_per_day: 10,
          },
        ];
      else if (sql.includes("JOIN pricing_market_price_estimates"))
        rows = [
          {
            catalog_catalog_item_id: "cat_synthetic_owner",
            product_id: "cat_synthetic_owner::",
            amount: "12.00",
            currency_code: "USD",
            fresh_until: new Date(at.getTime() + 3_600_000).toISOString(),
          },
        ];
      else if (
        sql.includes("pricing_market_listing_inputs") ||
        sql.includes("pricing_market_trades") ||
        sql.includes("pricing_repricing_product_round_cooldowns")
      )
        rows = [];
      else throw new Error(`Unexpected owner fixture SQL: ${sql.slice(0, 90)}`);
      return { rows: rows as Row[] };
    },
  };
  // Initial source history predates all grants. Subsequent commands use only the guarded writer.
  const initial = createRepricingPolicyRuntime({ eventStore: sourceStore, db });
  const external = createInMemoryEventStore().eventStore;
  const observations = createPricingAuthorityObservations(sourceStore);
  for (const input of [
    {
      streamId: "catalog.item-cat_synthetic_owner",
      events: [{ eventType: "catalog.catalog-item.created", payload: { itemId: "cat_synthetic_owner" } }],
    },
    {
      streamId: "inventory.item-inv_synthetic_owner",
      events: [
        {
          eventType: "inventory.item.created",
          payload: {
            itemId: "inv_synthetic_owner",
            accountId: context.audit.forAccountId,
            catalogItemId: "cat_synthetic_owner",
            productId: "cat_synthetic_owner::",
            totalQuantity: 1,
            acquisitionCostAmount: null,
            acquisitionCostCurrencyCode: null,
          },
        },
      ],
    },
    {
      streamId: "marketplace.listing-lst_synthetic_owner",
      events: [
        {
          eventType: "marketplace.listing.created",
          payload: {
            listingId: "lst_synthetic_owner",
            accountId: context.audit.forAccountId,
            inventoryItemId: "inv_synthetic_owner",
            catalogItemId: "cat_synthetic_owner",
            productId: "cat_synthetic_owner::",
            priceAmount: "10.00",
            priceCurrencyCode: "USD",
            quantityCap: 1,
          },
        },
        { eventType: "marketplace.listing.published", payload: {} },
      ],
    },
  ]) {
    const events = await external.appendToStream({ ...input, expectedVersion: 0, context });
    for (const event of events) await observations.observe(toTransportEvent(event));
  }
  await sourceStore.appendToStream({
    streamId: "pricing.market-price-estimate-cat_synthetic_owner::",
    expectedVersion: 0,
    context,
    events: [
      {
        eventType: "pricing.market-price.estimated",
        payload: {
          catalogItemId: "cat_synthetic_owner",
          productId: "cat_synthetic_owner::",
          amount: "12.00",
          currencyCode: "USD",
          freshUntil: new Date(at.getTime() + 3_600_000).toISOString(),
        },
      },
    ],
  });
  await initial.commandHandler({
    streamId: initial.streamIdForPolicy(policyId),
    context,
    command: {
      type: "CreateRepricingPolicy",
      policyId,
      accountId: context.audit.forAccountId,
      name: "Synthetic owner policy",
      scope: { kind: "all-listings" },
      rules,
      maxChangesPerDay: 10,
      createdAt: capturedAt,
    },
  });
  let authority: ReturnType<typeof createPricingListingAuthority>;
  let fence: ReturnType<typeof createListingAuthorityFence>;
  const request = {
    evaluationId: "synthetic-evaluation",
    accountId: context.audit.forAccountId,
    listingId: "lst_synthetic_owner",
    catalogItemId: "cat_synthetic_owner",
    productId: "cat_synthetic_owner::",
    target: { kind: "native-marketplace" as const },
    basePriceRevision: 1,
  };
  const reconstruct = () => {
    authority = createPricingListingAuthority(
      { eventStore: sourceStore, db, budget, now: () => at },
      {
        consumer: () => ({
          inspect: (operation) => fence.inspect(operation),
          invalidate: (operation, reason) => {
            if (blockInvalidation) throw new Error("Synthetic consumer unavailable.");
            return fence.forParticipant("pricing").invalidate(operation, reason);
          },
        }),
      },
    );
    fence = createListingAuthorityFence({
      eventStore: consumerStore,
      owner: "marketplace",
      participants: [authority.source],
    });
  };
  reconstruct();
  const evaluation = await authority!.evaluate(request, context);
  await authority!.evaluate(
    { ...request, target: { kind: "channel-connection", connectionId: "con_synthetic_second" } },
    context,
  );
  const input = {
    tenantId: context.tenantId,
    accountId: context.audit.forAccountId,
    actor: {
      kind: "standing-system" as const,
      userId: context.audit.performedByUserId,
      authorityId: policyId,
      authorityRevision: "1",
    },
    committingOwner: "marketplace" as const,
    kind: "accept-price" as const,
    requestId: "synthetic-request",
    command: {
      decision: evaluation.decision,
      priceAmount: evaluation.pair.amount,
      priceCurrencyCode: evaluation.pair.currencyCode,
    },
    listingId: request.listingId,
    subject: {
      inventoryItemId: "inv_synthetic_owner",
      catalogItemId: request.catalogItemId,
      productId: request.productId,
      selectedOptions: [],
      quantity: 1,
      pair: evaluation.pair,
      allocationRevision: null,
      commitmentSourceId: null,
    },
    target: request.target,
    expectedListingRevision: 2,
    expectedTargetRevision: 1,
    expectedVisibilityRevision: null,
    expectedPublicationRevision: null,
    participants: [{ owner: "pricing" as const, purpose: "evaluated-price" as const }],
  };
  const invalidate = async () => {
    const runtime = createRepricingPolicyRuntime({ eventStore: authority.eventStore, db });
    await runtime.setHalt(context.audit.forAccountId, true, context);
  };
  const restart = () => {
    reconstruct();
    return { sourceStore, consumerStore, source: authority.source, fence, context, input, invalidate, restart };
  };
  return {
    ...restart(),
    authority: authority!,
    request,
    evaluation,
    budgetRows,
    sourceMemory,
    consumerMemory,
    db,
    policyId,
    setEstimate: async (value: string) => {
      await sourceStore.appendToStream({
        streamId: "pricing.market-price-estimate-cat_synthetic_owner::",
        expectedVersion: 1,
        context,
        events: [
          {
            eventType: "pricing.market-price.estimated",
            payload: {
              catalogItemId: "cat_synthetic_owner",
              productId: "cat_synthetic_owner::",
              amount: value,
              currencyCode: "USD",
              freshUntil: new Date(at.getTime() + 3_600_000).toISOString(),
            },
          },
        ],
      });
    },
    blockInvalidation: (value: boolean) => {
      blockInvalidation = value;
    },
  };
}

describe("Actual Pricing source shared conformance", () => listingAuthorityConformance(it, fixture));

const proofs: ListingAuthorityOwnerProofs["pricing"] = {
  exactEvaluatedPairTargetAndDecisionBinding: async () => {
    const f = await fixture();
    expect(f.evaluation.pair).toEqual({ amount: "12.00", currencyCode: "USD" });
    expect((await f.authority.readEvaluation(f.request, f.context.tenantId))?.decision).toEqual(f.evaluation.decision);
    let caseNumber = 0;
    for (const command of [
      { ...f.input.command, decision: { ...f.evaluation.decision, evaluationRevision: "2" } },
      {
        ...f.input.command,
        decision: { ...f.evaluation.decision, goal: { goalId: "synthetic-invented", version: "1" } },
      },
    ]) {
      const operation = await f.fence.open(
        { ...f.input, requestId: `synthetic-altered-decision-${caseNumber++}`, command },
        f.context,
      );
      await expect(f.source.prepare(operation, f.context)).rejects.toThrow();
    }
  },
  policyGoalAndStandingAuthorizationInvalidation: async () => {
    const f = await fixture();
    const operation = await f.fence.open(f.input, f.context);
    const grant = await prepareListingStandingAuthority(operation, f.context, f.authority.standingAuthority);
    const terminal = await f.fence.prepareCommit(operation, [grant], {});
    await f.invalidate();
    expect((await f.fence.inspect(operation)).status).toBe("aborted");
    await expect(f.consumerStore.appendToStreams!(terminal)).rejects.toThrow();
  },
  dryRunHasNoReservationsOrEmission: async () => {
    const f = await fixture();
    const before = structuredClone([...f.sourceMemory.streams]);
    const budgets = structuredClone([...f.budgetRows]);
    const result = await f.authority.evaluate({ ...f.request, evaluationId: "synthetic-dry-run" }, f.context, true);
    expect(result.pair).toEqual(f.evaluation.pair);
    expect([...f.sourceMemory.streams]).toEqual(before);
    expect([...f.budgetRows]).toEqual(budgets);
  },
};
describe("Actual Pricing owner proofs", () => listingAuthorityOwnerConformance(it, "pricing", proofs));

it("does not trust a post-evaluation change in input evidence", async () => {
  const f = await fixture();
  await f.setEstimate("11.00");
  const operation = await f.fence.open(f.input, f.context);
  await expect(f.source.prepare(operation, f.context)).rejects.toThrow("inputs or assignment changed");
});

it("retains closure across restart and resumes the original writer plan", async () => {
  const f = await fixture();
  const operation = await f.fence.open(f.input, f.context);
  await f.source.prepare(operation, f.context);
  f.blockInvalidation(true);
  let pending: unknown;
  try {
    await f.invalidate();
  } catch (error) {
    pending = error;
  }
  expect(pending).toHaveProperty("inputs");
  expect((await f.fence.inspect(operation)).status).toBe("pending");
  await expect(f.source.settle(operation)).rejects.toThrow();
  f.restart();
  f.blockInvalidation(false);
  await f.authority.resumePending(pending as Parameters<typeof f.authority.resumePending>[0]);
  expect((await f.fence.inspect(operation)).status).toBe("aborted");
  await f.authority.resumePending(pending as Parameters<typeof f.authority.resumePending>[0]);
  expect(
    (await f.sourceStore.readStream({ streamId: `pricing.repricing-halt-${f.context.audit.forAccountId}` })).length,
  ).toBe(1);
});
