import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { PgQueryable, PostgresEventStore } from "@chase-sets/event-core-postgres";
import {
  evolvePolicyDocument,
  initialPolicyDocumentState,
  type PolicyDocumentEvent,
} from "@chase-sets/platform-policy/domain";
import { centsToMoneyAmount, moneyToCents } from "@chase-sets/primitives/money";
import type { RepricingConfigurationWriter } from "../../repricing-policies/api/configuration";
import { repricingPolicyScopeSpecificity, type RepricingPolicyState } from "../../repricing-policies/domain/domain";
import { evaluationDigest, sealCompetitorCapture, type CapturedCompetitor } from "../domain/evaluation-authority";
import { repricingEnginePolicy } from "../domain/policy";
import type { RepricingProductKey } from "./queries";

export function assignedPolicy(
  candidates: readonly Readonly<{ state: RepricingPolicyState; version: number }>[],
  listingId: string,
  categoryIds: readonly string[],
) {
  return candidates
    .filter(
      ({ state }) =>
        state.status === "active" &&
        !state.excludedListingIds.includes(listingId) &&
        (state.scope?.kind === "all-listings" ||
          (state.scope?.kind === "listing-set" && state.scope.listingIds.includes(listingId)) ||
          (state.scope?.kind === "catalog-filter" && state.scope.categoryIds.some((id) => categoryIds.includes(id)))),
    )
    .sort(
      (a, b) =>
        repricingPolicyScopeSpecificity(b.state.scope!) - repricingPolicyScopeSpecificity(a.state.scope!) ||
        Date.parse(b.state.updatedAt!) - Date.parse(a.state.updatedAt!) ||
        (a.state.policyId! < b.state.policyId! ? 1 : -1),
    )[0];
}

export function categoryPredicateIds(
  candidates: readonly Readonly<{ state: RepricingPolicyState }>[],
  listingId: string,
) {
  return [
    ...new Set(
      candidates.flatMap(({ state }) => {
        if (
          state.status !== "active" ||
          state.excludedListingIds.includes(listingId) ||
          (state.scope?.kind === "listing-set" && !state.scope.listingIds.includes(listingId))
        )
          return [];
        return [
          ...(state.scope?.kind === "catalog-filter" ? state.scope.categoryIds : []),
          ...state.rules.flatMap((rule) =>
            rule.conditions.flatMap((condition) => (condition.type === "category" ? [condition.categoryId] : [])),
          ),
        ];
      }),
    ),
  ].sort();
}

export async function captureCompetitors(
  db: PgQueryable,
  configuration: RepricingConfigurationWriter,
  product: RepricingProductKey,
  ownAccount: string,
  category: Readonly<{ version: number; categoryIds: readonly string[] }>,
) {
  const rows = await db.query<{
    listing_id: string;
    seller_account_id: string;
    price_amount: string;
    price_currency_code: string | null;
    last_stream_version: string;
  }>(
    `SELECT listing.listing_id, listing.seller_account_id, listing.price_amount::text, listing.price_currency_code,
       listing.last_stream_version::text
     FROM pricing_market_listing_inputs listing
     WHERE listing.catalog_catalog_item_id = $1 AND listing.product_id = $2
       AND listing.seller_account_id <> $3 AND listing.status = 'active'
     ORDER BY listing.listing_id LIMIT 10001`,
    [product.catalogItemId, product.productId, ownAccount],
  );
  if (rows.rows.length > 10000) throw new Error("Competitor capture exceeds its supported bound.");
  const classifications = new Map<string, Awaited<ReturnType<RepricingConfigurationWriter["captureAccount"]>>>();
  const asks: CapturedCompetitor[] = [];
  for (const row of rows.rows) {
    let current = classifications.get(row.seller_account_id);
    if (!current) {
      current = await configuration.captureAccount(db, row.seller_account_id, "competitor");
      classifications.set(row.seller_account_id, current);
    }
    const assignment = current.halt.state.engaged
      ? undefined
      : assignedPolicy(current.policies, row.listing_id, category.categoryIds);
    asks.push({
      listingId: row.listing_id,
      sellerAccountId: row.seller_account_id,
      listingVersion: Number(row.last_stream_version),
      amount: centsToMoneyAmount(moneyToCents(row.price_amount)),
      currencyCode: row.price_currency_code,
      pricingMode: assignment ? "derived" : "hard",
    });
  }
  const generation = evaluationDigest({ product, category, rows: rows.rows, sources: [...classifications] });
  return sealCompetitorCapture(generation, asks);
}

export async function capturePlatformPolicy(db: PgQueryable, store: PostgresEventStore, at: string) {
  const origins = await db.query<{ stream_id: string }>(
    `SELECT stream_id FROM event_store_events WHERE event_type = 'platform-policy.document.created'
       AND payload->>'policyKey' = $1 ORDER BY stream_id LIMIT 101`,
    [repricingEnginePolicy.policyKey],
  );
  if (origins.rows.length > 100) throw new Error("Platform pricing policy history exceeds its supported bound.");
  const codec = createPassthroughDomainEventCodec<PolicyDocumentEvent>();
  const documents = [];
  for (const { stream_id } of origins.rows) {
    const events = await readCompleteStream(
      { readStream: (request) => store.readStreamInTransaction(db, request) },
      { streamId: stream_id, maxEvents: 10000 },
    );
    const state = events.reduce(
      (prior, event) => evolvePolicyDocument(prior, codec.decode(event)),
      initialPolicyDocumentState,
    );
    if (!state.documentId || state.policyKey !== repricingEnginePolicy.policyKey || !state.effectiveFrom)
      throw new Error("Invalid platform pricing policy history.");
    const from = new Date(state.effectiveFrom).toISOString();
    const until = state.effectiveUntil === null ? null : new Date(state.effectiveUntil).toISOString();
    documents.push({
      documentId: state.documentId,
      version: events.length,
      from,
      until,
      status: state.status,
      value: repricingEnginePolicy.decodeValue(state.value),
    });
  }
  const active = documents.filter((document) => document.status === "active");
  const applicable = active.filter(
    (document) => document.from <= at && (document.until === null || at < document.until),
  );
  if (applicable.length > 1) throw new Error("Ambiguous platform pricing policy window.");
  return {
    selected: applicable[0] ?? null,
    value: applicable[0]?.value ?? repricingEnginePolicy.defaultValue,
    bounds: active
      .flatMap(({ from, until }) => [from, ...(until === null ? [] : [until])])
      .filter((bound) => bound > at),
  };
}
