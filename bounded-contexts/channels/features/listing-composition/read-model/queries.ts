import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { parseGradedCardSnapshot } from "@chase-sets/primitives/graded-card-snapshot";
import {
  buildChannelCategorySourceKeys,
  buildChannelConditionSourceKeys,
  buildChannelGradedAttributeSourceEntries,
} from "../domain/canonical";
import type {
  ChannelCompositionProfile,
  ChannelCompositionProfileRegistry,
  ChannelListingCompositionInput,
  ChannelListingLinkState,
  ChannelMappingResolution,
  ChannelMappingReviewPage,
  ChannelPublicationSettings,
  ChannelPublicationConnectionDetail,
  ChannelPublicationConnectionSummary,
  ChannelReferenceRead,
  ChannelReferenceResolution,
} from "../domain/contracts";
import {
  CHANNEL_STOCK_ALLOCATION_BUFFER_POLICY_FALLBACK,
  deriveChannelPublishQuantity,
  type ChannelStockAllocationBufferPolicyValue,
  type ChannelStockAllocationFacts,
} from "../domain/allocation";

export async function listChannelPublicationConnections(
  db: PgQueryable,
  input: Readonly<{ accountId: string }>,
): Promise<readonly ChannelPublicationConnectionSummary[]> {
  const result = await db.query<{
    connection_id: string;
    provider_key: string;
    environment: "sandbox" | "production";
    status: "pending-setup" | "active" | "paused" | "disconnected";
    settings_state: "missing" | "configured";
    review_count: string | number;
  }>(
    `SELECT connection.connection_id,connection.provider_key,connection.environment,connection.status,
       CASE WHEN settings.connection_id IS NULL THEN 'missing' ELSE 'configured' END AS settings_state,
       COUNT(mapping.source_key) FILTER (WHERE mapping.review_status NOT IN ('accepted','auto-accepted')) AS review_count
     FROM channels_connection_facts AS connection
     LEFT JOIN channels_connection_publication_settings AS settings ON settings.connection_id=connection.connection_id
     LEFT JOIN channels_channel_mappings AS mapping ON mapping.connection_id=connection.connection_id
     WHERE connection.account_id=$1
     GROUP BY connection.connection_id,connection.provider_key,connection.environment,connection.status,settings.connection_id
     ORDER BY connection.connection_id`,
    [input.accountId],
  );
  return result.rows.map((row) => ({
    connectionId: row.connection_id,
    providerKey: row.provider_key,
    environment: row.environment,
    connectionStatus: row.status,
    settingsState: row.settings_state,
    reviewCount: Number(row.review_count),
  }));
}

export async function readChannelPublicationConnection(
  db: PgQueryable,
  input: Readonly<{ accountId: string; connectionId: string; cursor?: string | null; limit?: number }>,
): Promise<ChannelPublicationConnectionDetail | null> {
  const summaries = await listChannelPublicationConnections(db, { accountId: input.accountId });
  const connection = summaries.find((item) => item.connectionId === input.connectionId);
  if (!connection) return null;
  const settings = await readSettings(db, input.connectionId);
  const mappingReview = await readChannelMappingReviewQueue(db, input);
  const version = await db.query<{ last_stream_version: string | number }>(
    `SELECT GREATEST(
       COALESCE((SELECT last_stream_version FROM channels_connection_publication_settings WHERE connection_id=$1),0),
       COALESCE((SELECT MAX(last_stream_version) FROM channels_channel_mappings WHERE connection_id=$1),0)
     ) AS last_stream_version`,
    [input.connectionId],
  );
  return {
    connection,
    settings,
    mappingReview,
    configurationStreamVersion: Number(version.rows[0]?.last_stream_version ?? 0),
  };
}

type ListingFactRow = Readonly<{
  listing_id: string;
  account_id: string;
  inventory_item_id: string;
  catalog_item_id: string;
  price_amount: string | null;
  price_currency_code: string | null;
  quantity_cap: number;
  selected_options: unknown;
  selected_option_key: string;
  listing_status: "draft" | "active" | "paused" | "withdrawn" | "auto-unlisted";
  item_title: string | null;
  item_subtitle: string | null;
  product_summary: string | null;
  graded_card: unknown;
  listing_stream_version: string | number;
  seller_availability_status: "available" | "unavailable";
}>;

export async function resolveChannelPublishableQuantity(
  db: PgQueryable,
  input: Readonly<{
    connectionId?: string;
    listingId: string;
    buffer?: ChannelStockAllocationBufferPolicyValue;
  }>,
): Promise<
  | Readonly<{ kind: "resolved"; publishableQuantity: number }>
  | Readonly<{ kind: "listing-facts-unavailable" }>
  | Readonly<{ kind: "inventory-facts-unavailable" }>
> {
  const result = await db.query<{
    quantity_cap: number;
    total_quantity: number | null;
    held_quantity: string | number;
    allocation_mode: "shared-pool" | "partitioned" | null;
    allocation_partitions: unknown;
  }>(
    `SELECT listing.quantity_cap, item.total_quantity,
            allocation.mode AS allocation_mode, allocation.partitions AS allocation_partitions,
            COALESCE(SUM(hold.quantity) FILTER (WHERE hold.status='active'),0) AS held_quantity
     FROM channels_listing_publication_facts AS listing
     LEFT JOIN channels_inventory_item_facts AS item ON item.item_id=listing.inventory_item_id
     LEFT JOIN channels_inventory_hold_facts AS hold ON hold.item_id=item.item_id
     LEFT JOIN channels_inventory_allocation_facts AS allocation
       ON allocation.item_id=listing.inventory_item_id AND allocation.account_id=listing.account_id
     WHERE listing.listing_id=$1
     GROUP BY listing.quantity_cap,item.total_quantity,allocation.mode,allocation.partitions`,
    [input.listingId],
  );
  const row = result.rows[0];
  if (!row) return { kind: "listing-facts-unavailable" };
  if (row.total_quantity === null) return { kind: "inventory-facts-unavailable" };
  const available = row.total_quantity - Number(row.held_quantity);
  const allocation: ChannelStockAllocationFacts = {
    mode: row.allocation_mode ?? "shared-pool",
    partitions: allocationPartitions(row.allocation_partitions),
  };
  return {
    kind: "resolved",
    publishableQuantity: deriveChannelPublishQuantity({
      available,
      listingQuantityCap: row.quantity_cap,
      channelConnectionId: input.connectionId ?? "",
      allocation,
      buffer: input.buffer ?? CHANNEL_STOCK_ALLOCATION_BUFFER_POLICY_FALLBACK,
    }),
  };
}

export async function readChannelListingCompositionFacts(
  db: PgQueryable,
  input: Readonly<{ connectionId: string; listingId: string }>,
  profiles?: ChannelCompositionProfileRegistry,
  buffer?: ChannelStockAllocationBufferPolicyValue,
): Promise<ChannelListingCompositionInput | null> {
  const connectionResult = await db.query<{
    connection_id: string;
    account_id: string;
    provider_key: string;
    environment: "sandbox" | "production";
    status: "pending-setup" | "active" | "paused" | "disconnected";
  }>(
    `SELECT connection_id,account_id,provider_key,environment,status FROM channels_connection_facts WHERE connection_id=$1`,
    [input.connectionId],
  );
  const connection = connectionResult.rows[0];
  if (!connection) return null;
  const profile = profiles?.get({
    providerKey: connection.provider_key,
    environment: connection.environment,
  });
  const listingResult = await db.query<ListingFactRow>(
    `SELECT listing.*,COALESCE(availability.status,'available') AS seller_availability_status
     FROM channels_listing_publication_facts AS listing
     LEFT JOIN channels_seller_availability_facts AS availability ON availability.account_id=listing.account_id
     WHERE listing.listing_id=$1 AND listing.account_id=$2`,
    [input.listingId, connection.account_id],
  );
  const listing = listingResult.rows[0];
  const quantity = await resolveChannelPublishableQuantity(db, {
    connectionId: input.connectionId,
    listingId: input.listingId,
    buffer: buffer ?? { bufferThresholdUnits: 0, bufferHoldbackUnits: 0 },
  });
  const categoryIds = listing ? await readCategoryIds(db, listing.catalog_item_id) : [];
  const references = listing
    ? await readReferencesForIdentity(db, connection.provider_key, listing.catalog_item_id, listing.selected_option_key)
    : { productReference: { kind: "unlinked" } as const, catalogItemReference: { kind: "unlinked" } as const };
  const settings = await readSettings(db, input.connectionId);
  const mappings = listing
    ? await readMappings(db, input.connectionId, {
        categoryIds,
        selectedOptions: parseSelections(listing.selected_options),
        gradedCard: listing.graded_card === null ? null : parseGradedCardSnapshot(listing.graded_card),
        profile,
      })
    : [];
  const link = await readLink(db, input.connectionId, input.listingId);
  return {
    connection: {
      connectionId: connection.connection_id,
      accountId: connection.account_id,
      providerKey: connection.provider_key,
      environment: connection.environment,
      connectionStatus: connection.status,
      publicationScopeState: { kind: "not-applicable" },
    },
    listing: !listing
      ? { kind: "facts-unavailable", listingId: input.listingId }
      : {
          kind: "present",
          listingId: listing.listing_id,
          listingRevision: Number(listing.listing_stream_version),
          listingStatus: listing.listing_status,
          sellerAvailabilityStatus: listing.seller_availability_status,
          identity: {
            catalogItemId: listing.catalog_item_id,
            selectedOptions: parseSelections(listing.selected_options),
            selectedOptionKey: listing.selected_option_key,
            categoryIds,
            itemTitle: optionalText(listing.item_title),
            itemSubtitle: optionalText(listing.item_subtitle),
            productSummary: optionalText(listing.product_summary),
            gradedCard:
              listing.graded_card === null
                ? { kind: "absent" }
                : { kind: "present", snapshot: parseGradedCardSnapshot(listing.graded_card)! },
          },
          offer: {
            price:
              listing.price_amount !== null && listing.price_currency_code !== null
                ? { kind: "present", amount: listing.price_amount, currencyCode: listing.price_currency_code }
                : { kind: "absent" },
            publishableQuantity:
              quantity.kind === "resolved"
                ? { kind: "resolved", value: quantity.publishableQuantity }
                : { kind: "unavailable" },
          },
        },
    providerProductReference: references.productReference,
    providerCatalogItemReference: references.catalogItemReference,
    settings: settings ? { kind: "configured", settings } : { kind: "missing" },
    link: link ? { kind: "existing", state: link } : { kind: "none" },
    profile: { kind: "unregistered" },
    mappings,
  };
}

export async function readChannelListingProviderProductReferences(
  db: PgQueryable,
  input: Readonly<{ connectionId: string; channelListingIds: readonly string[] }>,
): Promise<readonly ChannelReferenceRead[]> {
  if (input.channelListingIds.length === 0) return [];
  const result = await db.query<{
    channel_listing_id: string;
    product_count: string | number;
    product_provider_key: string | null;
    product_external_key: string | null;
    catalog_count: string | number;
    catalog_provider_key: string | null;
    catalog_external_key: string | null;
  }>(
    `SELECT link.channel_listing_id,
       product.candidate_count AS product_count,product.provider_key AS product_provider_key,product.external_key AS product_external_key,
       catalog.candidate_count AS catalog_count,catalog.provider_key AS catalog_provider_key,catalog.external_key AS catalog_external_key
     FROM channels_channel_listing_links AS link
     JOIN channels_listing_publication_facts AS listing ON listing.listing_id=link.listing_id
     JOIN channels_connection_facts AS connection ON connection.connection_id=link.connection_id
     LEFT JOIN LATERAL (
       SELECT COUNT(*) AS candidate_count,MIN(provider_key) AS provider_key,MIN(external_key) AS external_key
       FROM channels_external_product_reference_facts
       WHERE provider_key=connection.provider_key AND catalog_item_id=listing.catalog_item_id
         AND selected_option_key=listing.selected_option_key AND link_state='linked'
     ) AS product ON true
     LEFT JOIN LATERAL (
       SELECT COUNT(*) AS candidate_count,MIN(provider_key) AS provider_key,MIN(external_key) AS external_key
       FROM channels_external_catalog_item_reference_facts
       WHERE provider_key=connection.provider_key AND catalog_item_id=listing.catalog_item_id AND link_state='linked'
     ) AS catalog ON true
     WHERE link.connection_id=$1 AND link.channel_listing_id=ANY($2::text[])`,
    [input.connectionId, input.channelListingIds],
  );
  const byId = new Map(result.rows.map((row) => [row.channel_listing_id, row]));
  return input.channelListingIds.map((channelListingId) => {
    const row = byId.get(channelListingId);
    return {
      channelListingId,
      productReference: row
        ? referenceFromCount(row.product_count, row.product_provider_key, row.product_external_key)
        : { kind: "unlinked" },
      catalogItemReference: row
        ? referenceFromCount(row.catalog_count, row.catalog_provider_key, row.catalog_external_key)
        : { kind: "unlinked" },
    };
  });
}

export async function readChannelMappingReviewQueue(
  db: PgQueryable,
  input: Readonly<{ connectionId: string; cursor?: string | null; limit?: number }>,
): Promise<ChannelMappingReviewPage> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  const [cursorDimension, cursorSourceKey] = decodeCursor(input.cursor ?? null);
  const result = await db.query<{
    page_rows: Array<{
      connection_id: string;
      dimension: "category" | "condition" | "attribute";
      source_key: string;
      target_key: string | null;
      confidence_tier: "manual" | "high" | "medium" | "low";
      review_status: "proposed" | "rejected" | "revoked";
      provenance: "compose-discovered" | "export-discovered" | "operator";
      evidence: { listingId: string; derivedFrom: string };
      last_stream_version: string | number;
    }>;
    total: string | number;
  }>(
    `WITH queue AS MATERIALIZED (
       SELECT connection_id,dimension,source_key,target_key,confidence_tier,review_status,provenance,evidence,last_stream_version
       FROM channels_channel_mappings
       WHERE connection_id=$1 AND review_status NOT IN ('accepted','auto-accepted')
     ), page AS (
       SELECT * FROM queue
       WHERE (($2::text IS NULL) OR (dimension,source_key)>($2,$3))
       ORDER BY dimension,source_key LIMIT $4
     )
     SELECT COALESCE(jsonb_agg(page ORDER BY dimension,source_key),'[]'::jsonb) AS page_rows,
       (SELECT COUNT(*) FROM queue) AS total
     FROM page`,
    [input.connectionId, cursorDimension, cursorSourceKey, limit + 1],
  );
  const snapshot = result.rows[0] ?? { page_rows: [], total: 0 };
  const pageRows = snapshot.page_rows.slice(0, limit);
  const items = pageRows.map((row) => ({
    connectionId: row.connection_id,
    dimension: row.dimension,
    sourceKey: row.source_key,
    targetKey: row.target_key,
    confidenceTier: row.confidence_tier,
    reviewStatus: row.review_status,
    provenance: row.provenance,
    evidence: row.evidence,
    lastStreamVersion: Number(row.last_stream_version),
  }));
  const last = pageRows.at(-1);
  return {
    items,
    nextCursor: snapshot.page_rows.length > limit && last ? encodeCursor(last.dimension, last.source_key) : null,
    completeness: { kind: "complete", total: Number(snapshot.total) },
  };
}

export async function readAffectedListingIds(
  db: PgQueryable,
  input: Readonly<{
    connectionId: string;
    scope: "connection" | "account" | "catalog-item" | "inventory-item";
    scopeKey: string;
    afterListingId: string | null;
    limit: number;
  }>,
): Promise<readonly string[]> {
  const result = await db.query<{ listing_id: string }>(
    `SELECT listing.listing_id FROM channels_listing_publication_facts AS listing
     JOIN channels_connection_facts AS connection ON connection.connection_id=$1 AND connection.account_id=listing.account_id
     WHERE ($2='connection' AND connection.connection_id=$3 OR $2='account' AND listing.account_id=$3
       OR $2='catalog-item' AND listing.catalog_item_id=$3 OR $2='inventory-item' AND listing.inventory_item_id=$3)
       AND ($4::text IS NULL OR listing.listing_id>$4)
     ORDER BY listing.listing_id LIMIT $5`,
    [input.connectionId, input.scope, input.scopeKey, input.afterListingId, input.limit],
  );
  return result.rows.map((row) => row.listing_id);
}

export async function countAffectedListings(
  db: PgQueryable,
  input: Omit<Parameters<typeof readAffectedListingIds>[1], "afterListingId" | "limit">,
): Promise<number> {
  const result = await db.query<{ total: string | number }>(
    `SELECT COUNT(*) AS total FROM channels_listing_publication_facts AS listing
     JOIN channels_connection_facts AS connection ON connection.connection_id=$1 AND connection.account_id=listing.account_id
     WHERE ($2='connection' AND connection.connection_id=$3 OR $2='account' AND listing.account_id=$3
       OR $2='catalog-item' AND listing.catalog_item_id=$3 OR $2='inventory-item' AND listing.inventory_item_id=$3)`,
    [input.connectionId, input.scope, input.scopeKey],
  );
  return Number(result.rows[0]?.total ?? 0);
}

async function readCategoryIds(db: PgQueryable, catalogItemId: string): Promise<readonly string[]> {
  const result = await db.query<{ category_id: string }>(
    `SELECT category_id FROM channels_catalog_item_category_facts WHERE catalog_item_id=$1 AND assigned=true ORDER BY category_id`,
    [catalogItemId],
  );
  return result.rows.map((row) => row.category_id);
}

async function readReferencesForIdentity(
  db: PgQueryable,
  providerKey: string,
  catalogItemId: string,
  selectedOptionKey: string,
) {
  const product = await db.query<{ provider_key: string; external_key: string }>(
    `SELECT provider_key,external_key FROM channels_external_product_reference_facts
     WHERE provider_key=$1 AND catalog_item_id=$2 AND selected_option_key=$3 AND link_state='linked'
     ORDER BY external_key LIMIT 2`,
    [providerKey, catalogItemId, selectedOptionKey],
  );
  const catalog = await db.query<{ provider_key: string; external_key: string }>(
    `SELECT provider_key,external_key FROM channels_external_catalog_item_reference_facts
     WHERE provider_key=$1 AND catalog_item_id=$2 AND link_state='linked' ORDER BY external_key LIMIT 2`,
    [providerKey, catalogItemId],
  );
  return {
    productReference: referenceRows(product.rows),
    catalogItemReference: referenceRows(catalog.rows),
  };
}

async function readSettings(db: PgQueryable, connectionId: string): Promise<ChannelPublicationSettings | null> {
  const result = await db.query<{
    title_prefix: string;
    title_suffix: string;
    description_footer: string;
    category_allowlist: unknown;
    excluded_listing_ids: unknown;
  }>(
    `SELECT title_prefix,title_suffix,description_footer,category_allowlist,excluded_listing_ids
      FROM channels_connection_publication_settings WHERE connection_id=$1`,
    [connectionId],
  );
  const row = result.rows[0];
  return row
    ? {
        titlePrefix: row.title_prefix,
        titleSuffix: row.title_suffix,
        descriptionFooter: row.description_footer,
        categoryAllowlist: strings(row.category_allowlist),
        excludedListingIds: strings(row.excluded_listing_ids),
      }
    : null;
}

async function readMappings(
  db: PgQueryable,
  connectionId: string,
  listing: Readonly<{
    categoryIds: readonly string[];
    selectedOptions: readonly Readonly<{ dimensionId: string; optionId: string }>[];
    gradedCard: ReturnType<typeof parseGradedCardSnapshot>;
    profile?: ChannelCompositionProfile | null;
  }>,
): Promise<readonly ChannelMappingResolution[]> {
  const categorySourceKeys =
    !listing.profile || listing.profile.category.mode === "mapped"
      ? buildChannelCategorySourceKeys(listing.categoryIds)
      : [];
  const conditionSourceKeys = !listing.profile
    ? buildChannelConditionSourceKeys(listing.selectedOptions, listing.gradedCard, null).concat(
        listing.selectedOptions.map(({ dimensionId, optionId }) => `selected-option:${dimensionId}:${optionId}`),
      )
    : listing.profile.condition.mode === "mapped"
      ? buildChannelConditionSourceKeys(
          listing.selectedOptions,
          listing.gradedCard,
          listing.profile.conditionDimensionId,
        )
      : [];
  const attributeSourceKeys =
    !listing.profile || listing.profile.attributes.mode === "mapped"
      ? buildChannelGradedAttributeSourceEntries(listing.gradedCard).map(({ sourceKey }) => sourceKey)
      : [];
  const result = await db.query<{
    dimension: ChannelMappingResolution["dimension"];
    source_key: string;
    target_key: string | null;
    confidence_tier: ChannelMappingResolution["confidenceTier"];
    review_status: ChannelMappingResolution["reviewStatus"];
  }>(
    `SELECT dimension,source_key,target_key,confidence_tier,review_status FROM channels_channel_mappings
      WHERE connection_id=$1 AND (
        dimension='category' AND source_key=ANY($2::text[])
        OR dimension='condition' AND source_key=ANY($3::text[])
        OR dimension='attribute' AND source_key=ANY($4::text[])
      ) ORDER BY dimension,source_key`,
    [connectionId, categorySourceKeys, [...new Set(conditionSourceKeys)], attributeSourceKeys],
  );
  return result.rows.map((row) => ({
    dimension: row.dimension,
    sourceKey: row.source_key,
    targetKey: row.target_key,
    confidenceTier: row.confidence_tier,
    reviewStatus: row.review_status,
  }));
}

export async function readLink(
  db: PgQueryable,
  connectionId: string,
  listingId: string,
): Promise<ChannelListingLinkState | null> {
  const result = await db.query<Record<string, unknown>>(
    `SELECT * FROM channels_channel_listing_links WHERE connection_id=$1 AND listing_id=$2`,
    [connectionId, listingId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    connectionId: String(row.connection_id),
    channelListingId: String(row.channel_listing_id),
    listingId: String(row.listing_id),
    externalListingId: nullable(row.external_listing_id),
    externalOfferId: nullable(row.external_offer_id),
    providerRevision: nullable(row.provider_revision),
    lastDesiredStateSequence: nullableNumber(row.last_desired_state_sequence),
    lastDesiredListingRevision: nullableNumber(row.last_desired_listing_revision),
    lastDesiredStateHash: nullable(row.last_desired_state_hash),
    lastDesiredIntent: row.last_desired_intent as ChannelListingLinkState["lastDesiredIntent"],
    lastPushedListingRevision: nullableNumber(row.last_pushed_listing_revision),
    lastPushedPriceAmountMinor: nullableNumber(row.last_pushed_price_amount_minor),
    lastPushedPriceCurrency: nullable(row.last_pushed_price_currency),
    lastPushedQuantity: nullableNumber(row.last_pushed_quantity),
    publishState: row.publish_state as ChannelListingLinkState["publishState"],
    blockingReasonCodes: strings(row.blocking_reason_codes) as ChannelListingLinkState["blockingReasonCodes"],
    failureReason: nullable(row.failure_reason),
    driftStatus: nullable(row.drift_status),
    lastStreamVersion: Number(row.last_stream_version),
  };
}

function referenceRows(rows: readonly { provider_key: string; external_key: string }[]): ChannelReferenceResolution {
  if (rows.length === 0) return { kind: "unlinked" };
  if (rows.length > 1) return { kind: "ambiguous", candidateCount: rows.length };
  return { kind: "linked", providerKey: rows[0]!.provider_key, externalKey: rows[0]!.external_key };
}
function referenceFromCount(
  countValue: string | number,
  providerKey: string | null,
  externalKey: string | null,
): ChannelReferenceResolution {
  const count = Number(countValue);
  if (count === 0 || providerKey === null || externalKey === null) return { kind: "unlinked" };
  if (count > 1) return { kind: "ambiguous", candidateCount: count };
  return { kind: "linked", providerKey, externalKey };
}
function optionalText(value: string | null) {
  return value === null ? ({ kind: "absent" } as const) : ({ kind: "present", value } as const);
}
function parseSelections(value: unknown): readonly { dimensionId: string; optionId: string }[] {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is { dimensionId: string; optionId: string } =>
          !!entry &&
          typeof entry === "object" &&
          typeof entry.dimensionId === "string" &&
          typeof entry.optionId === "string",
      )
    : [];
}
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
function allocationPartitions(value: unknown): ChannelStockAllocationFacts["partitions"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) return [];
    const record = candidate as Record<string, unknown>;
    return typeof record.channelConnectionId === "string" && Number.isSafeInteger(record.units)
      ? [{ channelConnectionId: record.channelConnectionId, units: Number(record.units) }]
      : [];
  });
}
function nullable(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}
function encodeCursor(dimension: string, sourceKey: string): string {
  return Buffer.from(JSON.stringify([dimension, sourceKey])).toString("base64url");
}
function decodeCursor(cursor: string | null): readonly [string | null, string | null] {
  if (!cursor) return [null, null];
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    return Array.isArray(value) && typeof value[0] === "string" && typeof value[1] === "string"
      ? [value[0], value[1]]
      : [null, null];
  } catch {
    return [null, null];
  }
}
