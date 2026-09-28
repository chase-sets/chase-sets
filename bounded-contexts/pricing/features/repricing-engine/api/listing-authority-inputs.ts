import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  decidePolicyDocument,
  evolvePolicyDocument,
  initialPolicyDocumentState,
  type PolicyDocumentEvent,
} from "@chase-sets/platform-policy/domain";
import {
  decideRepricingPolicy,
  evolveRepricingPolicy,
  initialRepricingPolicyState,
  repricingPolicyScopeSpecificity,
  type RepricingPolicyEvent,
  type RepricingPolicyState,
} from "../../repricing-policies/domain/domain";
import {
  evolveRepricingHalt,
  initialRepricingHaltState,
  repricingHaltStreamId,
  type RepricingHaltEvent,
} from "../../repricing-policies/domain/halt";
import type { RepricingProductKey, RepricingRoundInputs } from "../read-model/queries";
import { activeProductFreeze, readProductRoundState } from "../read-model/product-round-state";
import { repricingEnginePolicy } from "../domain/policy";
import { pricingAuthorityDigest, pricingEvaluationResources } from "./listing-authority-resources";
import {
  readPricingObservations,
  pricingListingObservation,
  pricingCatalogCategories,
  pricingInventoryCost,
} from "./listing-authority-observations";

export type PricingAuthorityInputRequest = RepricingProductKey & Readonly<{ accountId: string; listingId: string }>;

/** Canonical Pricing observations and owner aggregates, not disposable assignment/input projections. */
export async function readPricingAuthorityInputs(
  deps: Readonly<{ eventStore: EventStore; db: PgQueryable }>,
  input: PricingAuthorityInputRequest,
  at: string,
) {
  const revisions: { resourceId: string; revision: string }[] = [];
  const observe = async (streamId: string) => {
    const history = await readPricingObservations(deps.eventStore, streamId);
    revisions.push({ resourceId: history.streamId, revision: String(history.version) });
    return history.events;
  };
  const candidates = await deps.db.query<{ source_stream_id: string }>(
    `SELECT DISTINCT payload->'event'->>'streamId' AS source_stream_id FROM event_store_events
     WHERE event_type = 'pricing.evaluation-input.observed'
       AND payload->'event'->>'type' = 'marketplace.listing.created'
       AND payload->'event'->'data'->>'catalogItemId' = $1 AND payload->'event'->'data'->>'productId' = $2
     ORDER BY source_stream_id LIMIT 501`,
    [input.catalogItemId, input.productId],
  );
  if (candidates.rows.length > 500) throw new Error("Pricing authority input page exceeds 500 listings.");
  const listings = [];
  for (const row of candidates.rows) {
    const listing = pricingListingObservation(await observe(row.source_stream_id));
    if (!listing || listing.catalogItemId !== input.catalogItemId || listing.productId !== input.productId)
      throw new Error("Pricing input selector returned incomplete or foreign evidence.");
    listings.push(listing);
  }
  const listing = listings.find((entry) => entry.listingId === input.listingId);
  if (
    !listing ||
    listing.sellerAccountId !== input.accountId ||
    (listing.status !== "active" && !(listing.status === "draft" && listing.publicationScope === "channel-only"))
  )
    throw new Error("Pricing requires a current active listing owned by this account.");
  const categories = pricingCatalogCategories(await observe(`catalog.item-${input.catalogItemId}`));
  const cost = pricingInventoryCost(await observe(`inventory.item-${listing.inventoryItemId}`), input.accountId);
  const asks = listings.filter((entry) => entry.nativeAsk);
  const accounts = [...new Set([input.accountId, ...asks.map((ask) => ask.sellerAccountId)])];
  const ids = await deps.db.query<{ stream_id: string }>(
    `SELECT DISTINCT stream_id FROM event_store_events
     WHERE (event_type = 'pricing.repricing-policy.created' AND payload->>'accountId' = ANY($1::text[]))
        OR (event_type = 'platform-policy.document.created' AND payload->>'policyKey' = $2)
     ORDER BY stream_id LIMIT 501`,
    [accounts, repricingEnginePolicy.policyKey],
  );
  if (ids.rows.length > 500) throw new Error("Pricing authority policy selection exceeds its bound.");
  const policyRepository = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<RepricingPolicyEvent>(),
    initialState: () => initialRepricingPolicyState,
    evolve: evolveRepricingPolicy,
    decide: decideRepricingPolicy,
  }).repository;
  const documentRepository = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<PolicyDocumentEvent>(),
    initialState: () => initialPolicyDocumentState,
    evolve: evolvePolicyDocument,
    decide: decidePolicyDocument,
  }).repository;
  const policies: Awaited<ReturnType<typeof policyRepository.load>>[] = [];
  const documents: Awaited<ReturnType<typeof documentRepository.load>>[] = [];
  for (const { stream_id: streamId } of ids.rows) {
    if (streamId.startsWith("pricing.repricing-policy-")) {
      const loaded = await policyRepository.load(streamId);
      if (!loaded.state.accountId || !accounts.includes(loaded.state.accountId))
        throw new Error("Foreign Pricing policy.");
      policies.push(loaded);
      revisions.push({ resourceId: streamId, revision: String(loaded.version) });
    } else if (streamId.startsWith("platform-policy.document-")) {
      const loaded = await documentRepository.load(streamId);
      if (loaded.state.policyKey !== repricingEnginePolicy.policyKey) throw new Error("Foreign engine policy.");
      documents.push(loaded);
      revisions.push({ resourceId: streamId, revision: String(loaded.version) });
    } else throw new Error("Unknown Pricing policy stream.");
  }
  const halted = new Set<string>();
  for (const accountId of accounts) {
    const streamId = repricingHaltStreamId(accountId);
    const history = await readCompleteStream(deps.eventStore, { streamId });
    const codec = createPassthroughDomainEventCodec<RepricingHaltEvent>();
    const state = history.reduce(
      (state, event) => evolveRepricingHalt(state, codec.decode(event)),
      initialRepricingHaltState,
    );
    if (state.engaged) halted.add(accountId);
    revisions.push({ resourceId: streamId, revision: String(history.at(-1)?.streamVersion ?? 0) });
  }
  const select = (accountId: string, listingId: string) =>
    policies
      .filter(
        ({ state }) => state.accountId === accountId && !halted.has(accountId) && matches(state, listingId, categories),
      )
      .sort(
        (a, b) =>
          repricingPolicyScopeSpecificity(b.state.scope!) - repricingPolicyScopeSpecificity(a.state.scope!) ||
          Date.parse(b.state.updatedAt!) - Date.parse(a.state.updatedAt!) ||
          b.state.policyId!.localeCompare(a.state.policyId!),
      )[0];
  const selected = select(input.accountId, input.listingId);
  if (!selected) throw new Error("Pricing has no active authoritative policy assignment.");
  const applicable = documents.filter(
    ({ state }) =>
      state.status === "active" &&
      state.effectiveFrom &&
      Date.parse(state.effectiveFrom) <= Date.parse(at) &&
      (state.effectiveUntil === null || Date.parse(state.effectiveUntil) > Date.parse(at)),
  );
  if (applicable.length > 1) throw new Error("Overlapping Pricing engine policy windows.");
  const enginePolicy = applicable[0]
    ? repricingEnginePolicy.decodeValue(applicable[0].state.value)
    : repricingEnginePolicy.defaultValue;
  const estimateStream = `pricing.market-price-estimate-${input.productId}`;
  const estimateHistory = await readCompleteStream(deps.eventStore, { streamId: estimateStream });
  const published = estimateHistory.at(-1)?.payload;
  const validityStream = `pricing.market-price-validity-${pricingAuthorityDigest(input.productId)}`;
  const validity = await readCompleteStream(deps.eventStore, { streamId: validityStream });
  revisions.push(
    { resourceId: estimateStream, revision: String(estimateHistory.at(-1)?.streamVersion ?? 0) },
    { resourceId: validityStream, revision: String(validity.at(-1)?.streamVersion ?? 0) },
  );
  let marketEstimate: RepricingRoundInputs["marketEstimate"] = null;
  if (published) {
    if (
      published.productId !== input.productId ||
      published.catalogItemId !== input.catalogItemId ||
      typeof published.amount !== "string" ||
      typeof published.currencyCode !== "string" ||
      typeof published.freshUntil !== "string"
    )
      throw new Error("Published Pricing estimate is incomplete or foreign.");
    const invalidations = validity.filter(
      (event) => event.payload.estimateRevision === estimateHistory.at(-1)!.streamVersion,
    );
    const freshUntil = invalidations.reduce((boundary, event) => {
      if (typeof event.payload.expiredAt !== "string") throw new Error("Pricing estimate validity is corrupt.");
      return Date.parse(event.payload.expiredAt) < Date.parse(boundary) ? event.payload.expiredAt : boundary;
    }, published.freshUntil);
    marketEstimate = { amount: published.amount, currencyCode: published.currencyCode, freshUntil };
  }
  const productState = await readProductRoundState(deps.db, input);
  if (activeProductFreeze(productState, at)) throw new Error("Pricing Product is held by Spiral Breaker.");
  const round: RepricingRoundInputs = {
    listings: [
      {
        ...listing,
        listingStatus: "active",
        categoryIds: categories,
        costBasisAmount: cost.amount,
        costBasisCurrencyCode: cost.currencyCode,
        policyId: selected.state.policyId!,
        policyRevision: String(selected.version),
        rules: selected.state.rules,
        maxChangesPerDay: selected.state.maxChangesPerDay!,
      },
    ],
    competingAsks: asks.map((ask) => ({
      listingId: ask.listingId,
      sellerAccountId: ask.sellerAccountId,
      amount: ask.priceAmount,
      currencyCode: ask.priceCurrencyCode,
      pricingMode: select(ask.sellerAccountId, ask.listingId) ? "derived" : "hard",
    })),
    marketEstimate,
    // Existing last-sold SQL is always currency-incomplete and cannot authorize a money anchor.
    lastSold: null,
  };
  const boundaries = [
    ...documents.flatMap(({ state }) => (state.status === "active" ? [state.effectiveFrom, state.effectiveUntil] : [])),
    marketEstimate?.freshUntil,
    new Date(Math.floor(Date.parse(at) / 60_000) * 60_000 + 60_000).toISOString(),
  ].filter((value): value is string => typeof value === "string" && Date.parse(value) > Date.parse(at));
  return {
    round,
    enginePolicy,
    resources: pricingEvaluationResources(round, input.listingId),
    revisions,
    policyId: selected.state.policyId!,
    policyRevision: String(selected.version),
    evidenceRevision: pricingAuthorityDigest({ round, enginePolicy, productState, revisions }),
    validBefore: boundaries.sort((a, b) => Date.parse(a) - Date.parse(b))[0]!,
  };
}

function matches(state: RepricingPolicyState, listingId: string, categories: readonly string[]) {
  if (state.status !== "active" || !state.scope || state.excludedListingIds.includes(listingId)) return false;
  return (
    state.scope.kind === "all-listings" ||
    (state.scope.kind === "listing-set"
      ? state.scope.listingIds.includes(listingId)
      : state.scope.categoryIds.some((id) => categories.includes(id)))
  );
}
