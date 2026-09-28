import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type {
  AcceptedListingTargetPriceV1,
  NativeListingEligibilityV1,
} from "@chase-sets/event-core/public-event-payloads";
import type { AcceptedListingTargetPriceRead, ListingTargetServices } from "../api/target-contracts";
import { listingPriceTargetKey, normalizeAcceptedListingPrice } from "../domain/target-price";

export type ListingCurrentReadiness = Readonly<{
  listingId: string;
  listingRevision: number;
  ready: boolean;
  generatedAt: string;
  validBefore: string;
}>;

/** Read-only owner facts. These never substitute for a final commitment reservation. */
export type ListingCurrentReadinessReader = (
  input: Readonly<{ accountId: string; listings: readonly NativeListingEligibilityV1[] }>,
) => Promise<readonly ListingCurrentReadiness[]>;

type Row = Readonly<{
  ordinal: number;
  listing_id: string;
  account_id: string;
  target_key: string;
  accepted_price: AcceptedListingTargetPriceV1 | null;
  activation_revision: number | null;
  listing_revision: number;
  native_visibility: string;
  visibility_revision: number;
  publication_revision: number | null;
  status: AcceptedListingTargetPriceRead["status"];
  source_event_id: string;
  source_global_position: string;
  active_generation: string | null;
  generated_at: string | Date;
  source_current: boolean;
}>;

export function assertListingReadFreshness(
  read: Readonly<{ generatedAt: string; sourceGlobalPosition: string; projectionGeneration: string | null }>,
  input: Readonly<{
    now: Date;
    maxAgeMs: number;
    minimumSourceGlobalPosition?: string;
    expectedProjectionGeneration?: string;
  }>,
) {
  const age = input.now.getTime() - Date.parse(read.generatedAt);
  if (
    !Number.isFinite(age) ||
    age < 0 ||
    !Number.isFinite(input.maxAgeMs) ||
    input.maxAgeMs < 0 ||
    age > input.maxAgeMs ||
    !/^\d+$/.test(read.sourceGlobalPosition) ||
    read.projectionGeneration === null ||
    !/^[1-9]\d*$/.test(read.projectionGeneration) ||
    (input.expectedProjectionGeneration !== undefined &&
      input.expectedProjectionGeneration !== read.projectionGeneration) ||
    (input.minimumSourceGlobalPosition !== undefined &&
      (!/^\d+$/.test(input.minimumSourceGlobalPosition) ||
        BigInt(read.sourceGlobalPosition) < BigInt(input.minimumSourceGlobalPosition)))
  )
    throw new Error("Listing read is stale or below the required source checkpoint.");
}

export function createListingCurrentReads(
  db: PgQueryable,
  readiness?: ListingCurrentReadinessReader,
): Pick<ListingTargetServices, "readAcceptedListingTargetPrices" | "readNativeListingEligibility"> {
  async function rows(input: Parameters<ListingTargetServices["readAcceptedListingTargetPrices"]>[0]) {
    if (!input.accountId.trim() || input.targets.length > 100)
      throw new Error("At most 100 account-scoped Listing reads are allowed.");
    const targets = input.targets.map((value, ordinal) => {
      if (!value.listingId.trim()) throw new Error("Listing identity is required.");
      return { ordinal, listingId: value.listingId, targetKey: listingPriceTargetKey(value.target) };
    });
    if (!targets.length) return [];
    // One statement snapshot checks the exact current source event, not just a global watermark.
    const result = await db.query<Row>(
      `
      WITH requested AS (
        SELECT * FROM jsonb_to_recordset($2::jsonb) AS r(ordinal integer, "listingId" text, "targetKey" text)
      )
      SELECT requested.ordinal, authority.listing_id, authority.account_id, requested."targetKey" AS target_key,
        target.accepted_price, NULLIF(target.activation_revision,0) AS activation_revision,
        authority.listing_revision, authority.native_visibility, authority.visibility_revision,
        authority.publication_revision, authority.status, authority.source_event_id,
        authority.source_global_position::text, generation.active_generation::text, statement_timestamp() AS generated_at,
        (authority.listing_revision=stream.current_version
          AND authority.source_event_id=source.event_id AND authority.source_global_position=source.global_position
          AND checkpoint.last_global_position >= source.global_position
          AND revision.projection_revision=2 AND generation.state='active' AND generation.rebuilding_generation IS NULL
          AND (target.accepted_price IS NULL OR (
            target.accepted_price->>'sourceEventId'=price_event.event_id
            AND (target.accepted_price->>'targetPriceRevision')::bigint=target.price_revision
            AND (price_event.payload->'acceptedTargetPrice'=target.accepted_price OR (
              price_event.payload->'acceptedTargetPrice' IS NULL AND requested."targetKey"='native-marketplace'
              AND price_event.event_type IN ('marketplace.listing.created','marketplace.listing.price-updated')
              AND price_event.payload->>'priceAmount'=target.accepted_price->>'priceAmount'
              AND price_event.payload->>'priceCurrencyCode'=target.accepted_price->>'priceCurrencyCode'
            ))
          ))
          AND NOT EXISTS (SELECT 1 FROM event_projection_blocked_streams blocked
            WHERE blocked.projection_key=checkpoint.checkpoint_key AND blocked.stream_id=stream.stream_id)
        ) IS TRUE AS source_current
      FROM requested
      JOIN marketplace_listing_native_authority authority ON authority.listing_id=requested."listingId" AND authority.account_id=$1
      JOIN event_store_streams stream ON stream.stream_id='marketplace.listing-' || authority.listing_id
      JOIN event_store_events source ON source.stream_id=stream.stream_id AND source.stream_version=stream.current_version
        AND source.for_account_id=$1
      LEFT JOIN marketplace_listing_target_prices target ON target.account_id=$1 AND target.listing_id=authority.listing_id
        AND target.target_key=requested."targetKey"
      LEFT JOIN event_store_events price_event ON price_event.stream_id=stream.stream_id AND price_event.stream_version=target.price_revision
      LEFT JOIN event_subscription_checkpoints checkpoint ON checkpoint.projection_name='marketplace-listing-projection'
        AND checkpoint.source_context_name='marketplace' AND checkpoint.subscription_version=3
      LEFT JOIN event_projection_group_revisions revision ON revision.target_context_name='marketplace'
        AND revision.projection_name='marketplace-listing-projection'
      LEFT JOIN event_projection_group_generations generation ON generation.target_context_name='marketplace'
        AND generation.projection_name='marketplace-listing-projection'
      ORDER BY requested.ordinal`,
      [input.accountId, JSON.stringify(targets)],
    );
    if (
      result.rows.length !== targets.length ||
      result.rows.some(
        (row, index) =>
          row.ordinal !== index || row.listing_id !== targets[index]!.listingId || row.account_id !== input.accountId,
      )
    )
      throw new Error("Listing current read membership is missing or changed.");
    for (const row of result.rows) {
      const accepted = row.accepted_price;
      if (!accepted) continue;
      const normalized = normalizeAcceptedListingPrice(accepted.priceAmount, accepted.priceCurrencyCode);
      if (
        accepted.schemaVersion !== 1 ||
        accepted.accountId !== input.accountId ||
        accepted.listingId !== row.listing_id ||
        listingPriceTargetKey(accepted.target) !== row.target_key ||
        accepted.targetPriceRevision > row.listing_revision ||
        !Number.isSafeInteger(accepted.targetPriceRevision) ||
        accepted.targetPriceRevision <= 0 ||
        normalized.priceAmount !== accepted.priceAmount ||
        normalized.priceCurrencyCode !== accepted.priceCurrencyCode
      )
        throw new Error("Listing accepted-price lineage is corrupt.");
    }
    return result.rows;
  }

  return {
    async readAcceptedListingTargetPrices(input) {
      return (await rows(input)).map((row, index) => {
        if (!row.source_current || !row.active_generation) throw new Error("Listing accepted-price source is stale.");
        const accepted = row.accepted_price;
        const requested = input.targets[index]!;
        if (
          accepted &&
          (accepted.accountId !== input.accountId ||
            accepted.listingId !== requested.listingId ||
            listingPriceTargetKey(accepted.target) !== row.target_key ||
            accepted.targetPriceRevision > row.listing_revision)
        )
          throw new Error("Listing accepted-price lineage is corrupt.");
        return {
          ...requested,
          acceptedTargetPrice: accepted,
          activationRevision:
            requested.target.kind === "native-marketplace" ? row.publication_revision : row.activation_revision,
          listingRevision: row.listing_revision,
          status: row.status,
          generatedAt: new Date(row.generated_at).toISOString(),
          sourceEventId: row.source_event_id,
          sourceGlobalPosition: row.source_global_position,
          projectionGeneration: row.active_generation,
        };
      });
    },
    async readNativeListingEligibility(input) {
      const current = await rows({
        accountId: input.accountId,
        targets: input.listingIds.map((listingId) => ({ listingId, target: { kind: "native-marketplace" } })),
      });
      const results: NativeListingEligibilityV1[] = current.map((row) => {
        const blockingReason = !row.source_current
          ? "source-stale"
          : row.native_visibility !== "enabled"
            ? "native-disabled"
            : row.publication_revision === null
              ? "native-unpublished"
              : row.status !== "active"
                ? "listing-not-active"
                : !row.accepted_price
                  ? "price-incomplete"
                  : null;
        return {
          schemaVersion: 1,
          accountId: input.accountId,
          listingId: row.listing_id,
          priceAmount: row.accepted_price?.priceAmount ?? null,
          priceCurrencyCode: row.accepted_price?.priceCurrencyCode ?? null,
          targetPriceRevision: row.accepted_price?.targetPriceRevision ?? 0,
          listingRevision: row.listing_revision,
          visibilityRevision: row.visibility_revision,
          nativePublicationRevision: row.publication_revision,
          eligible: false,
          blockingReason,
          sourceEventId: row.source_event_id,
          sourceGlobalPosition: row.source_global_position,
          projectionGeneration: row.active_generation,
          generatedAt: new Date(row.generated_at).toISOString(),
        };
      });
      const candidates = results.filter((row) => row.blockingReason === null);
      const overlays =
        candidates.length && readiness ? await readiness({ accountId: input.accountId, listings: candidates }) : [];
      const now = Date.now();
      return results.map((row) => {
        if (row.blockingReason !== null) return row;
        const matching = overlays.filter((entry) => entry.listingId === row.listingId);
        const overlay = matching.length === 1 ? matching[0] : undefined;
        const current =
          overlay &&
          overlay.listingRevision === row.listingRevision &&
          Date.parse(overlay.generatedAt) >= Date.parse(row.generatedAt) &&
          Date.parse(overlay.generatedAt) <= now &&
          Date.parse(overlay.validBefore) > now;
        return {
          ...row,
          eligible: Boolean(current && overlay.ready),
          blockingReason: !current ? "source-stale" : overlay.ready ? null : "native-not-ready",
        };
      });
    },
  };
}
