import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import { extractIdFromStreamId } from "@chase-sets/event-core";
import type {
  InventoryHoldPurpose,
  InventoryHoldReleaseReason,
  InventoryHoldSourceRef,
} from "@chase-sets/event-core/public-event-payloads";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { buildCatalogMirrorProjectionHandlers } from "@chase-sets/event-core-postgres/catalog-mirror";

async function refreshMarketplaceAccountReputation(db: PgQueryable, accountId: string, updatedAt: string) {
  await db.query(
    `INSERT INTO marketplace_account_pages (
       account_id,
       display_name,
       status,
       badges,
       average_rating,
       review_count,
       rating_1_count,
       rating_2_count,
       rating_3_count,
       rating_4_count,
       rating_5_count,
       reputation_updated_at,
       updated_at
     )
     SELECT
       $1,
       COALESCE((SELECT display_name FROM marketplace_account_pages WHERE account_id = $1), $1),
       COALESCE((SELECT status FROM marketplace_account_pages WHERE account_id = $1), 'active'),
       COALESCE((SELECT badges FROM marketplace_account_pages WHERE account_id = $1), '[]'::jsonb),
       CASE WHEN COUNT(*) = 0 THEN NULL ELSE ROUND(AVG(rating)::numeric, 2) END,
       COUNT(*)::integer,
       COUNT(*) FILTER (WHERE rating = 1)::integer,
       COUNT(*) FILTER (WHERE rating = 2)::integer,
       COUNT(*) FILTER (WHERE rating = 3)::integer,
       COUNT(*) FILTER (WHERE rating = 4)::integer,
       COUNT(*) FILTER (WHERE rating = 5)::integer,
       $2,
       $2
     FROM marketplace_account_reviews
     WHERE subject_account_id = $1
       AND status = 'active'
     ON CONFLICT (account_id) DO UPDATE SET
       average_rating = EXCLUDED.average_rating,
       review_count = EXCLUDED.review_count,
       rating_1_count = EXCLUDED.rating_1_count,
       rating_2_count = EXCLUDED.rating_2_count,
       rating_3_count = EXCLUDED.rating_3_count,
       rating_4_count = EXCLUDED.rating_4_count,
       rating_5_count = EXCLUDED.rating_5_count,
       reputation_updated_at = EXCLUDED.reputation_updated_at,
       updated_at = EXCLUDED.updated_at`,
    [accountId, updatedAt],
  );
}

async function updateMarketplaceAccountBadges(
  db: PgQueryable,
  params: Readonly<{ accountId: string; badgeKey: string; assigned: boolean; updatedAt: string }>,
) {
  await db.query(
    `INSERT INTO marketplace_account_pages (
       account_id,
       display_name,
       status,
       badges,
       updated_at
     ) VALUES (
       $1,
       $1,
       'active',
       CASE WHEN $3 THEN jsonb_build_array($2::text) ELSE '[]'::jsonb END,
       $4
     )
     ON CONFLICT (account_id) DO UPDATE SET
       badges = CASE
         WHEN $3 THEN (
           SELECT COALESCE(jsonb_agg(value ORDER BY value), '[]'::jsonb)
           FROM (
             SELECT DISTINCT value
             FROM jsonb_array_elements_text(marketplace_account_pages.badges || jsonb_build_array($2::text)) AS badge(value)
           ) badges
         )
         ELSE COALESCE(
           (
             SELECT jsonb_agg(value ORDER BY value)
             FROM jsonb_array_elements_text(marketplace_account_pages.badges) AS badge(value)
             WHERE value <> $2
           ),
           '[]'::jsonb
         )
       END,
       updated_at = EXCLUDED.updated_at`,
    [params.accountId, params.badgeKey, params.assigned, params.updatedAt],
  );
}

export function buildMarketplaceAccountProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "identity.account.created": async (event) => {
      const { accountId, displayName } = event.data as {
        accountId: string;
        displayName: string;
      };

      await db.query(
        `INSERT INTO marketplace_account_pages (
           account_id,
           display_name,
           status,
           badges,
           updated_at
         ) VALUES ($1, $2, 'active', '[]'::jsonb, $3)
         ON CONFLICT (account_id) DO UPDATE SET
           display_name = EXCLUDED.display_name,
           status = EXCLUDED.status,
           updated_at = EXCLUDED.updated_at`,
        [accountId, displayName, event.timing.recordedAt],
      );
    },
    "identity.account.profile-updated": async (event) => {
      const accountId = extractIdFromStreamId(event.streamId, "identity.account-");
      const { displayName } = event.data as { displayName: string };

      await db.query(
        `INSERT INTO marketplace_account_pages (
           account_id,
           display_name,
           status,
           badges,
           updated_at
         ) VALUES (
           $1,
           $2,
           COALESCE((SELECT status FROM marketplace_account_pages WHERE account_id = $1), 'active'),
           COALESCE((SELECT badges FROM marketplace_account_pages WHERE account_id = $1), '[]'::jsonb),
           $3
         )
         ON CONFLICT (account_id) DO UPDATE SET
           display_name = EXCLUDED.display_name,
           updated_at = EXCLUDED.updated_at`,
        [accountId, displayName, event.timing.recordedAt],
      );
    },
    "identity.account.suspended": async (event) => {
      await db.query(
        `UPDATE marketplace_account_pages
         SET status = 'suspended',
             updated_at = $2
         WHERE account_id = $1`,
        [extractIdFromStreamId(event.streamId, "identity.account-"), event.timing.recordedAt],
      );
    },
    "identity.account.reactivated": async (event) => {
      await db.query(
        `UPDATE marketplace_account_pages
         SET status = 'active',
             updated_at = $2
         WHERE account_id = $1`,
        [extractIdFromStreamId(event.streamId, "identity.account-"), event.timing.recordedAt],
      );
    },
    "identity.account.closed": async (event) => {
      await db.query(
        `UPDATE marketplace_account_pages
         SET status = 'closed',
             updated_at = $2
         WHERE account_id = $1`,
        [extractIdFromStreamId(event.streamId, "identity.account-"), event.timing.recordedAt],
      );
    },
    "identity.account.badge-assigned": async (event) => {
      const data = event.data as { badgeKey: string };
      await updateMarketplaceAccountBadges(db, {
        accountId: extractIdFromStreamId(event.streamId, "identity.account-"),
        badgeKey: data.badgeKey,
        assigned: true,
        updatedAt: event.timing.recordedAt,
      });
    },
    "identity.account.badge-removed": async (event) => {
      const data = event.data as { badgeKey: string };
      await updateMarketplaceAccountBadges(db, {
        accountId: extractIdFromStreamId(event.streamId, "identity.account-"),
        badgeKey: data.badgeKey,
        assigned: false,
        updatedAt: event.timing.recordedAt,
      });
    },
    "marketplace.review.submitted": async (event) => {
      const data = event.data as {
        reviewId: string;
        subjectAccountId: string;
        rating: number;
        submittedAt: string;
      };

      await db.query(
        `INSERT INTO marketplace_account_reviews (
           review_id,
           subject_account_id,
           rating,
           status,
           updated_at
         ) VALUES ($1, $2, $3, 'active', $4)
         ON CONFLICT (review_id) DO UPDATE SET
           subject_account_id = EXCLUDED.subject_account_id,
           rating = EXCLUDED.rating,
           status = EXCLUDED.status,
           updated_at = EXCLUDED.updated_at`,
        [data.reviewId, data.subjectAccountId, data.rating, data.submittedAt],
      );
      await refreshMarketplaceAccountReputation(db, data.subjectAccountId, data.submittedAt);
    },
    "marketplace.review.updated": async (event) => {
      const data = event.data as {
        reviewId: string;
        rating: number;
        updatedAt: string;
      };
      const subjectResult = await db.query<{ subject_account_id: string }>(
        `UPDATE marketplace_account_reviews
         SET rating = $2,
             updated_at = $3
         WHERE review_id = $1
         RETURNING subject_account_id`,
        [data.reviewId, data.rating, data.updatedAt],
      );
      const subjectAccountId = subjectResult.rows[0]?.subject_account_id;
      if (subjectAccountId) {
        await refreshMarketplaceAccountReputation(db, subjectAccountId, data.updatedAt);
      }
    },
    "marketplace.review.withdrawn": async (event) => {
      const data = event.data as {
        reviewId: string;
        withdrawnAt: string;
      };
      const subjectResult = await db.query<{ subject_account_id: string }>(
        `UPDATE marketplace_account_reviews
         SET status = 'withdrawn',
             updated_at = $2
         WHERE review_id = $1
         RETURNING subject_account_id`,
        [data.reviewId, data.withdrawnAt],
      );
      const subjectAccountId = subjectResult.rows[0]?.subject_account_id;
      if (subjectAccountId) {
        await refreshMarketplaceAccountReputation(db, subjectAccountId, data.withdrawnAt);
      }
    },
  };
}

export function buildMarketplaceCatalogProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    ...buildCatalogMirrorProjectionHandlers(db, {
      tablePrefix: "marketplace_catalog",
      itemStatusTransitions: { retired: "retired" },
      optionalHandlers: { displayIdentityResolved: true },
    }),
    "catalog.catalog-item.product-measures-resolved": async (event) => {
      const data = event.data as {
        catalogItemId: string;
        products?: unknown;
      };

      await db.query(
        `UPDATE marketplace_catalog_items
         SET product_measure_snapshots = $2,
             updated_at = $3
         WHERE catalog_item_id = $1`,
        [
          data.catalogItemId,
          JSON.stringify(Array.isArray(data.products) ? data.products : []),
          event.timing.recordedAt,
        ],
      );
    },
  };
}

async function markMarketplaceSupplyHoldTerminal(
  db: PgQueryable,
  params: Readonly<{
    holdId: string;
    status: "released" | "expired";
    releasedAt: string;
    releaseReason: InventoryHoldReleaseReason | null;
    recordedAt: string;
    streamVersion: number;
  }>,
): Promise<string | null> {
  const released = await db.query<{ item_id: string }>(
    `UPDATE marketplace_supply_holds
     SET status = $2,
         released_at = $3,
         release_reason = $4,
         updated_at = $5,
         last_stream_version = $6
     WHERE hold_id = $1
       AND last_stream_version < $6
     RETURNING item_id`,
    [params.holdId, params.status, params.releasedAt, params.releaseReason, params.recordedAt, params.streamVersion],
  );

  return released.rows[0]?.item_id ?? null;
}

export function buildMarketplaceInventoryProjectionHandlers(
  db: PgQueryable,
  options: Readonly<{
    onInventoryItemChanged?: (itemId: string) => Promise<void>;
  }> = {},
): ProjectorHandlerMap {
  return {
    "inventory.storage-location.created": async (event) => {
      const data = event.data as {
        storageLocationId: string;
        accountId: string;
        name: string;
        shipFromCode: string;
        shipFromAddress: unknown;
      };

      await db.query(
        `INSERT INTO marketplace_supply_locations (
           storage_location_id,
           account_id,
           name,
           ship_from_code,
           ship_from_address,
           is_archived,
           updated_at
         ) VALUES ($1, $2, $3, $4, $5, false, $6)
         ON CONFLICT (storage_location_id) DO UPDATE SET
           account_id = EXCLUDED.account_id,
           name = EXCLUDED.name,
           ship_from_code = EXCLUDED.ship_from_code,
           ship_from_address = EXCLUDED.ship_from_address,
           is_archived = false,
           updated_at = EXCLUDED.updated_at`,
        [
          data.storageLocationId,
          data.accountId,
          data.name,
          data.shipFromCode,
          JSON.stringify(data.shipFromAddress),
          event.timing.recordedAt,
        ],
      );
    },
    "inventory.storage-location.updated": async (event) => {
      const data = event.data as {
        storageLocationId: string;
        name: string;
        shipFromCode: string;
        shipFromAddress: unknown;
      };

      await db.query(
        `UPDATE marketplace_supply_locations
         SET name = $2,
             ship_from_code = $3,
             ship_from_address = $4,
             updated_at = $5
         WHERE storage_location_id = $1`,
        [
          data.storageLocationId,
          data.name,
          data.shipFromCode,
          JSON.stringify(data.shipFromAddress),
          event.timing.recordedAt,
        ],
      );
    },
    "inventory.storage-location.archived": async (event) => {
      const { storageLocationId } = event.data as { storageLocationId: string };

      await db.query(
        `UPDATE marketplace_supply_locations
         SET is_archived = true,
             updated_at = $2
         WHERE storage_location_id = $1`,
        [storageLocationId, event.timing.recordedAt],
      );
    },
    "inventory.item.created": async (event) => {
      const data = event.data as {
        itemId: string;
        accountId: string;
        catalogItemId: string;
        productId: string;
        selectedOptions: unknown;
        gradedCard: unknown;
        storageLocationId: string;
        totalQuantity: number;
        acquisitionCostAmount: string | null;
      };

      await db.query(
        `INSERT INTO marketplace_supply_items (
           item_id,
           account_id,
           catalog_catalog_item_id,
           product_id,
           selected_options,
           graded_card,
           storage_location_id,
           total_quantity,
           acquisition_cost_amount,
           last_stream_version,
           updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (item_id) DO UPDATE SET
           account_id = EXCLUDED.account_id,
           catalog_catalog_item_id = EXCLUDED.catalog_catalog_item_id,
           product_id = EXCLUDED.product_id,
           selected_options = EXCLUDED.selected_options,
           graded_card = EXCLUDED.graded_card,
           storage_location_id = EXCLUDED.storage_location_id,
           total_quantity = EXCLUDED.total_quantity,
           acquisition_cost_amount = EXCLUDED.acquisition_cost_amount,
           last_stream_version = EXCLUDED.last_stream_version,
           updated_at = EXCLUDED.updated_at
         WHERE marketplace_supply_items.last_stream_version < EXCLUDED.last_stream_version`,
        [
          data.itemId,
          data.accountId,
          data.catalogItemId,
          data.productId,
          JSON.stringify(Array.isArray(data.selectedOptions) ? data.selectedOptions : []),
          data.gradedCard === null || typeof data.gradedCard !== "object" ? null : JSON.stringify(data.gradedCard),
          data.storageLocationId,
          data.totalQuantity,
          data.acquisitionCostAmount,
          event.streamVersion,
          event.timing.recordedAt,
        ],
      );

      await options.onInventoryItemChanged?.(data.itemId);
    },
    "inventory.item.adjusted": async (event) => {
      const data = event.data as {
        itemId: string;
        quantityDelta: number;
      };

      await db.query(
        `UPDATE marketplace_supply_items
         SET total_quantity = total_quantity + $2,
             updated_at = $3,
             last_stream_version = $4
         WHERE item_id = $1
           AND last_stream_version < $4`,
        [data.itemId, data.quantityDelta, event.timing.recordedAt, event.streamVersion],
      );

      await options.onInventoryItemChanged?.(data.itemId);
    },
    "inventory.hold.placed": async (event) => {
      const data = event.data as {
        holdId: string;
        accountId: string;
        itemId: string;
        quantity: number;
        reason?: string;
        notes?: string | null;
        purpose?: InventoryHoldPurpose;
        sourceRef?: InventoryHoldSourceRef;
        expiresAt?: string | null;
      };
      const anatomy = holdAnatomyFromPlacedPayload(data);

      await db.query(
        `INSERT INTO marketplace_supply_holds (
           hold_id,
           account_id,
           item_id,
           quantity,
           purpose,
           source_ref,
           expires_at,
           status,
           released_at,
           release_reason,
           last_stream_version,
           updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', NULL, NULL, $8, $9)
         ON CONFLICT (hold_id) DO UPDATE SET
           account_id = EXCLUDED.account_id,
           item_id = EXCLUDED.item_id,
           quantity = EXCLUDED.quantity,
           purpose = EXCLUDED.purpose,
           source_ref = EXCLUDED.source_ref,
           expires_at = EXCLUDED.expires_at,
           status = EXCLUDED.status,
           released_at = EXCLUDED.released_at,
           release_reason = EXCLUDED.release_reason,
           last_stream_version = EXCLUDED.last_stream_version,
           updated_at = EXCLUDED.updated_at
         WHERE marketplace_supply_holds.last_stream_version < EXCLUDED.last_stream_version`,
        [
          data.holdId,
          data.accountId,
          data.itemId,
          data.quantity,
          anatomy.purpose,
          anatomy.sourceRef ? JSON.stringify(anatomy.sourceRef) : null,
          anatomy.expiresAt,
          event.streamVersion,
          event.timing.recordedAt,
        ],
      );

      await options.onInventoryItemChanged?.(data.itemId);
    },
    "inventory.hold.converted": async (event) => {
      const data = event.data as {
        holdId: string;
        purpose: InventoryHoldPurpose;
        sourceRef: InventoryHoldSourceRef;
        expiresAt: string | null;
      };

      await db.query(
        `UPDATE marketplace_supply_holds
         SET purpose = $2,
             source_ref = $3,
             expires_at = $4,
             updated_at = $5,
             last_stream_version = $6
         WHERE hold_id = $1
           AND last_stream_version < $6`,
        [
          data.holdId,
          data.purpose,
          data.sourceRef ? JSON.stringify(data.sourceRef) : null,
          data.expiresAt,
          event.timing.recordedAt,
          event.streamVersion,
        ],
      );
    },
    "inventory.hold.extended": async (event) => {
      const data = event.data as {
        holdId: string;
        expiresAt: string;
      };

      await db.query(
        `UPDATE marketplace_supply_holds
         SET expires_at = $2,
             updated_at = $3,
             last_stream_version = $4
         WHERE hold_id = $1
           AND last_stream_version < $4`,
        [data.holdId, data.expiresAt, event.timing.recordedAt, event.streamVersion],
      );
    },
    "inventory.hold.released": async (event) => {
      const data = event.data as {
        holdId: string;
        releasedAt: string;
        releaseReason?: InventoryHoldReleaseReason;
      };

      const itemId = await markMarketplaceSupplyHoldTerminal(db, {
        holdId: data.holdId,
        status: "released",
        releasedAt: data.releasedAt,
        releaseReason: data.releaseReason ?? null,
        recordedAt: event.timing.recordedAt,
        streamVersion: event.streamVersion,
      });
      if (itemId) {
        await options.onInventoryItemChanged?.(itemId);
      }
    },
    "inventory.hold.expired": async (event) => {
      const data = event.data as {
        holdId: string;
        expiredAt: string;
      };

      const itemId = await markMarketplaceSupplyHoldTerminal(db, {
        holdId: data.holdId,
        status: "expired",
        releasedAt: data.expiredAt,
        releaseReason: "checkout-expired",
        recordedAt: event.timing.recordedAt,
        streamVersion: event.streamVersion,
      });
      if (itemId) {
        await options.onInventoryItemChanged?.(itemId);
      }
    },
  };
}

type PlacedHoldPayload = Readonly<{
  reason?: string;
  notes?: string | null;
  purpose?: InventoryHoldPurpose;
  sourceRef?: InventoryHoldSourceRef;
  expiresAt?: string | null;
}>;

function holdAnatomyFromPlacedPayload(data: PlacedHoldPayload): Readonly<{
  purpose: InventoryHoldPurpose;
  sourceRef: InventoryHoldSourceRef;
  expiresAt: string | null;
}> {
  if (data.purpose) {
    return {
      purpose: data.purpose,
      sourceRef: data.sourceRef ?? null,
      expiresAt: data.expiresAt ?? null,
    };
  }

  return {
    purpose: data.reason === "Ordering commitment" ? "order" : "manual",
    sourceRef: null,
    expiresAt: null,
  };
}
