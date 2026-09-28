import { describe, expect, it } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createListingAuthorityParticipant } from "@chase-sets/platform-runtime/listing-authority-participant";
import {
  createListingAuthorityFence,
  type ListingAuthorityOperationInput,
} from "@chase-sets/platform-runtime/listing-authority-fence";
import { createPolicyRuntime } from "@chase-sets/platform-policy/runtime";
import {
  marketplaceListingEvidencePolicy,
  LISTING_EVIDENCE_LAUNCH_POLICY_VALUE,
} from "../../listing-evidence-policy/domain/policy";
import { decideMarketplaceListing, evolveMarketplaceListing, initialMarketplaceListingState } from "../domain/domain";
import { marketplaceListingCodec } from "../domain/codec";
import { createListingEvidenceRequirementSnapshot } from "../domain/evidence-requirement-snapshot";
import { createMarketplaceListingAuthority } from "./listing-authority";

const measure = {
  catalogItemId: "cat_synthetic",
  productId: "cat_synthetic::",
  selectedOptions: [],
  measureVersion: "synthetic-measure",
  unitLengthInches: 3,
  unitWidthInches: 2,
  unitHeightInches: 0.01,
  unitWeightOunces: 1,
  physicalFlags: ["raw-card"],
  stackBehavior: "stackable-thickness",
  source: "profile",
  confidence: "measured",
} as const;
const requirements = createListingEvidenceRequirementSnapshot(
  {
    policyId: null,
    policyVersion: null,
    policyHash: "synthetic",
    matchedRuleIds: [],
    explanationCodes: [],
    effectiveInterval: { from: null, until: null },
    requirements: { minimumPhotoCount: 0, requiredSlots: [], sellerTrustRequirements: [], buyerAcknowledgment: "none" },
  },
  new Date().toISOString(),
);

async function fixture(selectedOptions: readonly { dimensionId: string; optionId: string }[] = []) {
  const memory = createInMemoryEventStore();
  const consumer = createInMemoryEventStore();
  const context: EventStoreContext = {
    tenantId: "tnt_synthetic",
    audit: { forAccountId: "acc_synthetic", performedByUserId: "usr_synthetic" },
  };
  const db: PgQueryable = {
    async query<Row>(sql: string, values?: readonly unknown[]) {
      if (sql.includes("WITH documents"))
        return {
          rows: [...memory.streams]
            .filter(([, events]) => events[0]?.payload.policyKey === values?.[0])
            .map(([stream_id]) => ({ stream_id })) as Row[],
        };
      if (sql.includes("AS review_count")) return { rows: [{ review_count: "0" }] as Row[] };
      if (sql.includes("AS account_id"))
        return {
          rows: [...memory.streams.values()].flatMap((events) =>
            events
              .filter(
                (event) =>
                  event.eventType === "marketplace.review.submitted" &&
                  (values?.[0] as string[]).includes(String(event.payload.orderId)),
              )
              .map((event) => ({ account_id: event.payload.subjectAccountId })),
          ) as Row[],
        };
      return { rows: [] as Row[] };
    },
  };
  const upstream = (
    [
      { owner: "identity", purpose: "manage-listing" },
      { owner: "catalog", purpose: "product-measures" },
      { owner: "inventory", purpose: "stock-allocation" },
    ] as const
  ).map((participant) =>
    createListingAuthorityParticipant({
      eventStore: createInMemoryEventStore().eventStore,
      participant,
      consumer: () => fence.forParticipant(participant.owner),
      resources: () => ["synthetic-upstream"],
      validate: async (operation) => ({
        value: {},
        sourceRevisions: [{ resourceId: "synthetic-upstream", revision: "1" }],
        validBefore: operation.prepareBefore,
      }),
    }),
  );
  const restart = () =>
    createMarketplaceListingAuthority(
      { eventStore: memory.eventStore, db },
      {
        consumer: () => fence.forParticipant("marketplace"),
        identity: { participant: upstream[0]!, sellerFacts: () => ({ badgeKeys: [] }) },
        catalog: {
          participant: upstream[1]!,
          readFacts: async () => ({
            catalogItemId: measure.catalogItemId,
            productId: measure.productId,
            blueprintId: "blue_synthetic",
            categoryIds: [],
            selectedOptions,
            productMeasureSnapshot: { ...measure, selectedOptions },
            productMeasureRevision: 1,
          }),
        },
        inventory: upstream[2],
      },
    );
  const authority = restart();
  const fence = createListingAuthorityFence({
    eventStore: consumer.eventStore,
    owner: "ordering",
    participants: [...upstream, authority.commitment, authority.readiness],
  });
  const { repository, commandHandler } = createAggregateCommandHandler({
    eventStore: authority.eventStore,
    codec: marketplaceListingCodec,
    initialState: () => initialMarketplaceListingState,
    evolve: evolveMarketplaceListing,
    decide: decideMarketplaceListing,
  });
  await commandHandler({
    streamId: "marketplace.listing-lst_synthetic",
    context,
    command: {
      type: "CreateListing",
      listingId: "lst_synthetic" as never,
      accountId: "acc_synthetic" as never,
      inventoryItemId: "inv_synthetic",
      catalogItemId: "cat_synthetic" as never,
      productId: "cat_synthetic::" as never,
      itemTitle: null,
      itemSubtitle: null,
      selectedOptions: [...selectedOptions],
      productSummary: null,
      productMeasureSnapshot: { ...measure, selectedOptions },
      storageLocationName: null,
      shipFromCode: null,
      shipFromAddress: {
        name: "Synthetic",
        company: null,
        line1: "1 Test St",
        line2: null,
        city: "Austin",
        state: "TX",
        postalCode: "78701",
        country: "US",
        phone: null,
        email: null,
      },
      priceAmount: "10.00",
      priceCurrencyCode: "USD",
      quantityCap: 2,
      evidenceRequirements: requirements,
      feeLock: {
        unitCount: 2,
        marketplaceSalesFeeUnitAmount: "0.50",
        sellerNetUnitAmount: "9.50",
        feeQuoteFingerprint: "synthetic-quote",
        terms: {
          marketplaceSalesFeePercentageBps: 500,
          marketplaceSalesFeeFixedAmount: "0.00",
          marketplaceSalesFeeCapAmount: null,
          shippingAllowancePercentageBps: 0,
          termsScheduleId: null,
          termsAgreementId: null,
          termsResolvedAt: new Date().toISOString(),
        },
      },
    },
  });
  await commandHandler({
    streamId: "marketplace.listing-lst_synthetic",
    context,
    command: {
      type: "PublishListing",
      readiness: { ready: true, requirementHash: requirements.requirementHash, unmetCodes: [], coverage: null },
    },
  });
  const listing = await repository.load("marketplace.listing-lst_synthetic");
  const input: ListingAuthorityOperationInput = {
    tenantId: context.tenantId,
    accountId: context.audit.forAccountId,
    actor: { kind: "user", userId: context.audit.performedByUserId },
    committingOwner: "ordering",
    kind: "native-commitment",
    requestId: "synthetic-order",
    command: { orderId: "ord_synthetic" },
    listingId: "lst_synthetic",
    subject: {
      inventoryItemId: "inv_synthetic",
      catalogItemId: "cat_synthetic",
      productId: "cat_synthetic::",
      selectedOptions,
      quantity: 1,
      pair: { amount: "10.00", currencyCode: "USD" },
      allocationRevision: null,
      commitmentSourceId: "ord_synthetic",
    },
    target: { kind: "native-marketplace" },
    expectedListingRevision: listing.version,
    expectedTargetRevision: listing.state.nativePriceRevision,
    expectedVisibilityRevision: listing.state.nativeVisibilityRevision,
    expectedPublicationRevision: listing.state.nativePublicationRevision,
    participants: [...upstream.map((source) => source.participant), authority.commitment.participant],
  };
  async function prepare() {
    const operation = await fence.open(input, context);
    const grant = await authority.commitment.prepare(operation, context);
    const grants = [grant, ...(await Promise.all(upstream.map((source) => source.inspect(operation))))];
    return {
      operation,
      grants: grants.map((grant) => {
        if (!grant) throw new Error("missing upstream");
        return grant;
      }),
    };
  }
  return { memory, consumer, context, db, upstream, restart, authority, fence, input, prepare, commandHandler };
}

describe("Marketplace native owner participation", () => {
  it("accepts equivalent selection objects after durable writer key canonicalization", async () => {
    const f = await fixture([{ optionId: "opt_synthetic", dimensionId: "dim_synthetic" }]);
    await expect(f.prepare()).resolves.toMatchObject({ grants: expect.any(Array) });
  });

  it("retains every upstream reservation through the final Ordering commit and preserves commit-wins", async () => {
    const f = await fixture();
    const { operation, grants } = await f.prepare();
    expect(grants.every((grant) => grant.operation.operationId === operation.operationId)).toBe(true);
    await f.consumer.eventStore.appendToStreams!([await f.fence.prepareCommit(operation, grants, { ordered: true })]);
    await f.commandHandler({
      streamId: "marketplace.listing-lst_synthetic",
      context: f.context,
      command: { type: "PauseListing" },
    });
    expect((await f.fence.inspect(operation)).status).toBe("committed");
    await f.fence.settle(operation);
    expect((await f.restart().commitment.inspect(operation))?.status).toBe("consumed");
    const next = await f.fence.open({ ...f.input, requestId: "next-order" }, f.context);
    await expect(f.authority.commitment.prepare(next, f.context)).rejects.toThrow("revision changed");
  });

  it.each(["listing", "availability", "policy", "review", "review-hold", "review-scoring"])(
    "%s writer aborts a prepared final consumer before its effect",
    async (writer) => {
      const f = await fixture();
      if (writer.startsWith("review"))
        await f.authority.eventStore.appendToStream({
          streamId: "marketplace.review-rev_synthetic",
          expectedVersion: 0,
          context: f.context,
          events: [
            {
              eventType: "marketplace.review.submitted",
              payload: { orderId: "ord_review", subjectAccountId: "acc_synthetic", authorRole: "buyer" },
            },
          ],
        });
      const { operation, grants } = await f.prepare();
      if (writer === "listing")
        await f.commandHandler({
          streamId: "marketplace.listing-lst_synthetic",
          context: f.context,
          command: { type: "PauseListing" },
        });
      else if (writer === "policy") {
        const policies = createPolicyRuntime({ eventStore: f.authority.eventStore, db: f.db });
        await policies.createPolicyDocument(
          marketplaceListingEvidencePolicy,
          {
            value: LISTING_EVIDENCE_LAUNCH_POLICY_VALUE,
            status: "active",
            effectiveFrom: new Date().toISOString(),
            effectiveUntil: null,
            actorUserId: f.context.audit.performedByUserId,
          },
          f.context,
        );
      } else {
        const streamId =
          writer === "availability"
            ? "marketplace.seller-listing-availability-acc_synthetic"
            : writer === "review"
              ? "marketplace.review-rev_synthetic"
              : `marketplace.${writer}-ord_review`;
        const eventType =
          writer === "availability"
            ? "marketplace.seller-listing-availability.disabled"
            : writer === "review"
              ? "marketplace.review.withdrawn"
              : writer === "review-hold"
                ? "marketplace.review-hold.placed"
                : "marketplace.review-scoring.disposition-projected.v1";
        await f.authority.eventStore.appendToStream({
          streamId,
          expectedVersion: writer === "review" ? 1 : 0,
          context: f.context,
          events: [{ eventType, payload: { accountId: "acc_synthetic", orderId: "ord_review" } }],
        });
      }
      expect((await f.fence.inspect(operation)).status).toBe("aborted");
      await expect(f.fence.prepareCommit(operation, grants, { ordered: true })).rejects.toThrow();
      await f.fence.settle(operation);
      expect((await f.restart().commitment.inspect(operation))?.status).toBe("released");
    },
  );

  it("rejects upstream omission rather than inventing an intermediate readiness authority", async () => {
    const f = await fixture();
    const operation = await f.fence.open({ ...f.input, participants: [f.authority.commitment.participant] }, f.context);
    await expect(f.authority.commitment.prepare(operation, f.context)).rejects.toThrow();
  });

  it("caps the promise at a scheduled seller away boundary", async () => {
    const f = await fixture();
    const startsAt = new Date(Date.now() + 25_000).toISOString();
    await f.authority.eventStore.appendToStream({
      streamId: "marketplace.seller-listing-availability-acc_synthetic",
      expectedVersion: 0,
      context: f.context,
      events: [
        {
          eventType: "marketplace.seller-listing-availability.away-window-scheduled",
          payload: { accountId: "acc_synthetic", startsAt, endsAt: null, reasonCategory: "travel" },
        },
      ],
    });
    const { grants } = await f.prepare();
    expect(grants[0]!.validBefore).toBe(startsAt);
  });
});
