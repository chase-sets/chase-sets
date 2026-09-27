import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { AcceptedListingTargetPriceV1 } from "@chase-sets/event-core/public-event-payloads";
import { listingPriceTargetKey } from "../domain/target-price";

export const marketplaceListingTargetSchemaSql = `
CREATE TABLE IF NOT EXISTS marketplace_listing_target_prices (
  account_id text NOT NULL,
  listing_id text NOT NULL,
  target_key text NOT NULL,
  accepted_price jsonb NULL,
  price_revision integer NOT NULL DEFAULT 0,
  activation_revision integer NOT NULL DEFAULT 0,
  allocation_revision integer NULL,
  generated_at timestamptz NOT NULL,
  source_global_position bigint NOT NULL,
  PRIMARY KEY (account_id, listing_id, target_key)
);
CREATE TABLE IF NOT EXISTS marketplace_listing_native_authority (
  listing_id text PRIMARY KEY,
  account_id text NOT NULL,
  native_visibility text NOT NULL DEFAULT 'disabled',
  visibility_revision integer NOT NULL DEFAULT 0,
  publication_revision integer NULL,
  status text NOT NULL DEFAULT 'draft',
  status_revision integer NOT NULL DEFAULT 0,
  listing_revision integer NOT NULL DEFAULT 0,
  source_event_id text NOT NULL,
  source_global_position bigint NOT NULL,
  generated_at timestamptz NOT NULL
);
`;

export function buildMarketplaceListingTargetProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  const project: ProjectorHandlerMap[string] = async (event) => {
    const listingId = event.streamId.slice("marketplace.listing-".length);
    const accountId = event.audit.forAccountId;
    const created = event.type === "marketplace.listing.created";
    const nativePrice = created || event.type === "marketplace.listing.price-updated";
    const externalPrice = event.type === "marketplace.listing.target-price-accepted";
    if (nativePrice || externalPrice) {
      const explicit = event.data.acceptedTargetPrice as AcceptedListingTargetPriceV1 | undefined;
      const historical: AcceptedListingTargetPriceV1 | null =
        typeof event.data.priceAmount === "string" && typeof event.data.priceCurrencyCode === "string"
          ? {
              schemaVersion: 1,
              accountId,
              listingId,
              target: { kind: "native-marketplace" },
              priceAmount: event.data.priceAmount,
              priceCurrencyCode: event.data.priceCurrencyCode,
              targetPriceRevision: event.streamVersion,
              listingRevision: event.streamVersion,
              acceptedByUserId: event.audit.performedByUserId,
              acceptedAt: event.timing.occurredAt,
              sourceEventId: event.id,
              decision: {
                kind: created && event.data.schemaVersion === 2 ? "seller-reference" : "legacy-native-anchor",
              },
              connectionAuthority: null,
            }
          : null;
      const accepted = explicit ?? historical;
      if (externalPrice && !explicit) throw new Error("External acceptance payload is missing.");
      if (
        explicit &&
        (explicit.accountId !== accountId ||
          explicit.listingId !== listingId ||
          explicit.targetPriceRevision !== event.streamVersion ||
          explicit.sourceEventId !== event.id ||
          explicit.acceptedByUserId !== event.audit.performedByUserId ||
          (externalPrice
            ? explicit.target.kind !== "channel-connection"
            : explicit.target.kind !== "native-marketplace"))
      ) {
        throw new Error("Accepted target lineage does not match its owner event.");
      }
      const key = accepted ? listingPriceTargetKey(accepted.target) : "native-marketplace";
      await db.query(
        `INSERT INTO marketplace_listing_target_prices
        (account_id, listing_id, target_key, accepted_price, price_revision, generated_at, source_global_position)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (account_id, listing_id, target_key) DO UPDATE SET
          accepted_price = EXCLUDED.accepted_price, price_revision = EXCLUDED.price_revision,
          generated_at = EXCLUDED.generated_at,
          source_global_position = GREATEST(marketplace_listing_target_prices.source_global_position, EXCLUDED.source_global_position)
        WHERE marketplace_listing_target_prices.price_revision < EXCLUDED.price_revision`,
        [
          accountId,
          listingId,
          key,
          accepted ? JSON.stringify(accepted) : null,
          event.streamVersion,
          new Date().toISOString(),
          event.globalPosition,
        ],
      );
    }
    if (event.type === "marketplace.listing.channel-activated") {
      const key = listingPriceTargetKey({
        kind: "channel-connection",
        connectionId: String(event.data.connectionId ?? ""),
      });
      await db.query(
        `INSERT INTO marketplace_listing_target_prices
        (account_id, listing_id, target_key, activation_revision, allocation_revision, generated_at, source_global_position)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (account_id, listing_id, target_key) DO UPDATE SET
          activation_revision = EXCLUDED.activation_revision, allocation_revision = EXCLUDED.allocation_revision,
          generated_at = EXCLUDED.generated_at,
          source_global_position = GREATEST(marketplace_listing_target_prices.source_global_position, EXCLUDED.source_global_position)
        WHERE marketplace_listing_target_prices.activation_revision < EXCLUDED.activation_revision`,
        [
          accountId,
          listingId,
          key,
          event.streamVersion,
          event.data.allocationRevision,
          new Date().toISOString(),
          event.globalPosition,
        ],
      );
    }
    const visibility = created
      ? (event.data.nativeVisibility ?? "enabled")
      : event.type === "marketplace.listing.native-visibility-changed"
        ? event.data.nativeVisibility
        : null;
    const status = created
      ? "draft"
      : [
            "marketplace.listing.published",
            "marketplace.listing.channel-activated",
            "marketplace.listing.resumed",
          ].includes(event.type)
        ? "active"
        : ["marketplace.listing.paused", "marketplace.listing.auto-unlisted"].includes(event.type)
          ? "paused"
          : event.type === "marketplace.listing.withdrawn"
            ? "withdrawn"
            : null;
    const publication = event.type === "marketplace.listing.published" ? event.streamVersion : null;
    await db.query(
      `INSERT INTO marketplace_listing_native_authority
      (listing_id, account_id, native_visibility, visibility_revision, publication_revision, status, status_revision,
       listing_revision, source_event_id, source_global_position, generated_at)
      VALUES ($1, $2, COALESCE($3, 'disabled'), CASE WHEN $3::text IS NULL THEN 0 ELSE $5 END, $4,
        COALESCE($6, 'draft'), CASE WHEN $6::text IS NULL THEN 0 ELSE $5 END, $5, $7, $8, $9)
      ON CONFLICT (listing_id) DO UPDATE SET
        native_visibility = CASE WHEN $3::text IS NOT NULL AND $5 > marketplace_listing_native_authority.visibility_revision THEN $3 ELSE marketplace_listing_native_authority.native_visibility END,
        visibility_revision = CASE WHEN $3::text IS NOT NULL THEN GREATEST($5, marketplace_listing_native_authority.visibility_revision) ELSE marketplace_listing_native_authority.visibility_revision END,
        publication_revision = GREATEST($4, marketplace_listing_native_authority.publication_revision),
        status = CASE WHEN $6::text IS NOT NULL AND $5 > marketplace_listing_native_authority.status_revision THEN $6 ELSE marketplace_listing_native_authority.status END,
        status_revision = CASE WHEN $6::text IS NOT NULL THEN GREATEST($5, marketplace_listing_native_authority.status_revision) ELSE marketplace_listing_native_authority.status_revision END,
        listing_revision = GREATEST($5, marketplace_listing_native_authority.listing_revision),
        source_event_id = CASE WHEN $5 > marketplace_listing_native_authority.listing_revision THEN $7 ELSE marketplace_listing_native_authority.source_event_id END,
        source_global_position = GREATEST($8, marketplace_listing_native_authority.source_global_position), generated_at = $9`,
      [
        listingId,
        accountId,
        visibility,
        publication,
        event.streamVersion,
        status,
        event.id,
        event.globalPosition,
        new Date().toISOString(),
      ],
    );
  };
  return Object.fromEntries(
    [
      "created",
      "price-updated",
      "target-price-accepted",
      "channel-activated",
      "native-visibility-changed",
      "resumed",
      "published",
      "paused",
      "auto-unlisted",
      "withdrawn",
      "quantity-cap-updated",
      "purchase-limits-updated",
      "photos-added",
      "photo-classified",
      "photo-replaced",
      "photo-removed",
      "photos-reordered",
      "evidence-requirements-refreshed",
    ].map((name) => [`marketplace.listing.${name}`, project]),
  );
}
