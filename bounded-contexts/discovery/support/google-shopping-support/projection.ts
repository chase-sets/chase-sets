import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  refreshGoogleShoppingFeedRowsForCatalogItem,
  type GoogleShoppingIncrementalSyncReason,
} from "./feed-row-projection";

const ITEM_STREAM_PREFIX = "catalog.item-";

function extractIdFromStreamId(streamId: string, prefix: string): string {
  if (!streamId.startsWith(prefix)) {
    throw new Error(`Stream ID "${streamId}" does not start with prefix "${prefix}".`);
  }

  return streamId.slice(prefix.length);
}

async function refreshCatalogItemRows(
  db: PgQueryable,
  event: Parameters<ProjectorHandlerMap[string]>[0],
  catalogItemId: string,
  reason: GoogleShoppingIncrementalSyncReason,
) {
  await refreshGoogleShoppingFeedRowsForCatalogItem(db, catalogItemId, {
    reason,
    requestedAt: event.timing.recordedAt,
  });
}

export function buildGoogleShoppingFeedRowProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "catalog.catalog-item.created": async (event) => {
      const { itemId } = event.data as { itemId: string };
      await refreshCatalogItemRows(db, event, itemId, "catalog");
    },
    "catalog.catalog-item.field-value-set": async (event) => {
      await refreshCatalogItemRows(db, event, extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX), "catalog");
    },
    "catalog.catalog-item.field-value-cleared": async (event) => {
      await refreshCatalogItemRows(db, event, extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX), "catalog");
    },
    "catalog.catalog-item.published": async (event) => {
      await refreshCatalogItemRows(db, event, extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX), "eligibility");
    },
    "catalog.catalog-item.metadata-revised": async (event) => {
      await refreshCatalogItemRows(db, event, extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX), "catalog");
    },
    "catalog.catalog-item.display-identity-resolved": async (event) => {
      const { catalogItemId } = event.data as { catalogItemId: string };
      await refreshCatalogItemRows(db, event, catalogItemId, "catalog");
    },
    "catalog.catalog-item.image-urls-set": async (event) => {
      await refreshCatalogItemRows(db, event, extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX), "image");
    },
    "catalog.catalog-item.product-asset-sets-set": async (event) => {
      await refreshCatalogItemRows(db, event, extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX), "image");
    },
    "catalog.catalog-item.image-fallback-set": async (event) => {
      await refreshCatalogItemRows(db, event, extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX), "image");
    },
    "catalog.catalog-item.image-fallback-cleared": async (event) => {
      await refreshCatalogItemRows(db, event, extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX), "image");
    },
    "catalog.catalog-item.retired": async (event) => {
      await refreshCatalogItemRows(db, event, extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX), "eligibility");
    },
    "catalog.catalog-item.archived": async (event) => {
      await refreshCatalogItemRows(db, event, extractIdFromStreamId(event.streamId, ITEM_STREAM_PREFIX), "eligibility");
    },
  };
}
