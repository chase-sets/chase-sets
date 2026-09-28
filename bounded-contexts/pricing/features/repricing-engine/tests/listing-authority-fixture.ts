import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { toTransportEvent } from "@chase-sets/event-core/transport";
import { createPricingAuthorityObservations } from "../api/listing-authority-observations";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createListingAuthorityFence } from "@chase-sets/platform-runtime/listing-authority-fence";
import { createRepricingPolicyRuntime } from "../../repricing-policies/api/runtime";
import type { RepricingRule } from "../../repricing-policies/domain/domain";
import {
  createPricingListingAuthority,
  PricingAuthorityMutationPendingError,
  type PricingEvaluationBudget,
} from "../api/listing-authority";

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
export async function fixture(
  options: {
    sourceStore?: EventStore;
    consumerStore?: EventStore;
    db?: PgQueryable;
    budget?: PricingEvaluationBudget;
  } = {},
) {
  const sourceMemory = createInMemoryEventStore();
  const consumerMemory = createInMemoryEventStore();
  const sourceStore = options.sourceStore ?? sourceMemory.eventStore;
  const consumerStore = options.consumerStore ?? consumerMemory.eventStore;
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
  const budget: PricingEvaluationBudget = options.budget ?? {
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
  const db: PgQueryable = options.db ?? {
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
      else if (sql.includes("pricing_repricing_product_round_cooldowns")) rows = [];
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
          estimatedAt: capturedAt,
          freshUntil: new Date(at.getTime() + 3_600_000).toISOString(),
          estimateVersion: 1,
          window: { startedAt: new Date(at.getTime() - 86_400_000).toISOString(), endedAt: capturedAt },
          confidence: "medium",
          inputs: { platformVerifiedTradeCount: 3, platformTradeCount: 5, externalCompCount: 0 },
          previousAmount: "11.00",
          disclosure: "account",
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
  let retainedHalt: PricingAuthorityMutationPendingError | null = null;
  const invalidate = async () => {
    if (retainedHalt) {
      await authority.resumePending(retainedHalt);
      return;
    }
    const runtime = createRepricingPolicyRuntime({ eventStore: authority.eventStore, db });
    try {
      await runtime.setHalt(context.audit.forAccountId, true, context);
    } catch (error) {
      if (error instanceof PricingAuthorityMutationPendingError) retainedHalt = error;
      throw error;
    }
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
    external,
    rules,
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
