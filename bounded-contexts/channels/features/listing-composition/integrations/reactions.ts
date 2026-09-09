import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { EventStoreContext, GlobalPosition } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { JsonObject } from "@chase-sets/primitives/json";
import type { ChannelListingCompositionServices } from "../api/runtime";
import { channelListingEventCodec } from "../domain/codecs";
import type { OutboundSyncServices } from "../../outbound-sync/domain/contracts";

type SignalEvent = Readonly<{
  id: string;
  type: string;
  streamId: string;
  streamVersion: number;
  globalPosition: GlobalPosition;
  data: JsonObject;
  tenantId: string;
  audit: Readonly<{ performedByUserId: string; forAccountId: string }>;
  trace: EventStoreContext["trace"];
  timing: Readonly<{ occurredAt: string }>;
}>;

const listingEvents = [
  "marketplace.listing.created",
  "marketplace.listing.price-updated",
  "marketplace.listing.quantity-cap-updated",
  "marketplace.listing.published",
  "marketplace.listing.paused",
  "marketplace.listing.auto-unlisted",
  "marketplace.listing.withdrawn",
] as const;
const availabilityEvents = [
  "marketplace.seller-listing-availability.enabled",
  "marketplace.seller-listing-availability.disabled",
] as const;
const inventoryEvents = [
  "inventory.item.created",
  "inventory.item.adjusted",
  "inventory.hold.placed",
  "inventory.hold.converted",
  "inventory.hold.extended",
  "inventory.hold.released",
  "inventory.hold.expired",
  "inventory.hold.consumed",
] as const;
const catalogEvents = [
  "catalog.catalog-item.category-assigned",
  "catalog.catalog-item.category-removed",
  "catalog.catalog-item.external-product-reference-linked",
  "catalog.catalog-item.external-product-reference-unlinked",
  "catalog.catalog-item.external-catalog-item-reference-linked",
  "catalog.catalog-item.external-catalog-item-reference-unlinked",
] as const;
const connectionEvents = [
  "channels.connection.connected",
  "channels.connection.activated",
  "channels.connection.paused",
  "channels.connection.resumed",
  "channels.connection.disconnected",
] as const;
const configurationEvents = [
  "channels.channel-publication-configuration.settings-replaced",
  "channels.channel-publication-configuration.mapping-candidate-recorded",
  "channels.channel-publication-configuration.mapping-review-decided",
] as const;
const reconciliationEvents = [
  "channels.channel-listing-reconciliation.run-enqueued",
  "channels.channel-listing-reconciliation.chunk-drained",
] as const;

export function buildChannelMarketplaceDesiredStateReactionHandlers(
  db: PgQueryable,
  services: ChannelListingCompositionServices,
): ProjectorHandlerMap {
  const handlers: { [key: string]: ProjectorHandlerMap[string] } = {};
  for (const eventType of listingEvents)
    handlers[eventType] = async (value) => {
      const event = value as unknown as SignalEvent;
      const listingId =
        event.type === "marketplace.listing.created" && typeof event.data.listingId === "string"
          ? event.data.listingId
          : event.streamId.replace("marketplace.listing-", "");
      const connections = await db.query<{ connection_id: string }>(
        `SELECT connection.connection_id FROM channels_connection_facts AS connection
       JOIN channels_listing_publication_facts AS listing ON listing.account_id=connection.account_id
       WHERE listing.listing_id=$1 ORDER BY connection.connection_id`,
        [listingId],
      );
      for (const connection of connections.rows) {
        await services.recordChannelListingDesiredState(
          { connectionId: connection.connection_id, listingId },
          context(event),
        );
      }
    };
  for (const eventType of availabilityEvents)
    handlers[eventType] = async (value) => {
      const event = value as unknown as SignalEvent;
      const accountId = String(event.data.accountId);
      const connections = await db.query<{ connection_id: string }>(
        `SELECT connection_id FROM channels_connection_facts WHERE account_id=$1 ORDER BY connection_id`,
        [accountId],
      );
      for (const connection of connections.rows) {
        await services.enqueueChannelListingDesiredStateReconciliation(
          {
            connectionId: connection.connection_id,
            scope: "account",
            scopeKey: accountId,
          },
          context(event),
        );
      }
    };
  return handlers;
}

export function buildChannelInventoryDesiredStateReactionHandlers(
  db: PgQueryable,
  services: ChannelListingCompositionServices,
): ProjectorHandlerMap {
  return Object.fromEntries(
    inventoryEvents.map((eventType) => [
      eventType,
      async (value: unknown) => {
        const event = value as SignalEvent;
        const itemId =
          event.type.startsWith("inventory.hold.") && event.type !== "inventory.hold.placed"
            ? await findHoldItemId(db, String(event.data.holdId))
            : String(event.data.itemId);
        if (!itemId) return;
        const connections = await connectionsForInventoryItem(db, itemId);
        for (const connectionId of connections) {
          await services.enqueueChannelListingDesiredStateReconciliation(
            { connectionId, scope: "inventory-item", scopeKey: itemId },
            context(event),
          );
        }
      },
    ]),
  );
}

export function buildChannelCatalogDesiredStateReactionHandlers(
  db: PgQueryable,
  services: ChannelListingCompositionServices,
): ProjectorHandlerMap {
  return Object.fromEntries(
    catalogEvents.map((eventType) => [
      eventType,
      async (value: unknown) => {
        const event = value as SignalEvent;
        const catalogItemId = event.streamId.replace("catalog.catalog-item-", "");
        const result = await db.query<{ connection_id: string }>(
          `SELECT DISTINCT connection.connection_id FROM channels_connection_facts AS connection
       JOIN channels_listing_publication_facts AS listing ON listing.account_id=connection.account_id
       WHERE listing.catalog_item_id=$1 ORDER BY connection.connection_id`,
          [catalogItemId],
        );
        for (const row of result.rows) {
          await services.enqueueChannelListingDesiredStateReconciliation(
            {
              connectionId: row.connection_id,
              scope: "catalog-item",
              scopeKey: catalogItemId,
            },
            context(event),
          );
        }
      },
    ]),
  );
}

export function buildChannelOwnedDesiredStateReactionHandlers(
  services: ChannelListingCompositionServices,
  outboundSync: Pick<OutboundSyncServices, "enqueueDesiredState">,
): ProjectorHandlerMap {
  const handlers: { [key: string]: ProjectorHandlerMap[string] } = {};
  for (const eventType of connectionEvents)
    handlers[eventType] = async (value) => {
      const event = value as unknown as SignalEvent;
      const connectionId = String(event.data.connectionId);
      await services.enqueueChannelListingDesiredStateReconciliation(
        {
          connectionId,
          scope: "connection",
          scopeKey: connectionId,
        },
        context(event),
      );
    };
  for (const eventType of configurationEvents)
    handlers[eventType] = async (value) => {
      const event = value as unknown as SignalEvent;
      const connectionId = String(event.data.connectionId);
      await services.enqueueChannelListingDesiredStateReconciliation(
        {
          connectionId,
          scope: "connection",
          scopeKey: connectionId,
        },
        context(event),
      );
    };
  for (const eventType of reconciliationEvents)
    handlers[eventType] = async (value) => {
      const event = value as unknown as SignalEvent;
      await services.drainChannelListingDesiredStateReconciliation(
        { runId: String(event.data.runId), limit: 100 },
        context(event),
      );
    };
  handlers["channels.channel-listing.desired-state-changed"] = async (value) => {
    const source = value as unknown as SignalEvent;
    const event = channelListingEventCodec.decode({ eventType: source.type, payload: source.data });
    if (event.type !== "channels.channel-listing.desired-state-changed") return;
    await outboundSync.enqueueDesiredState({
      connectionId: event.data.connectionId,
      channelListingId: event.data.channelListingId,
      listingId: event.data.listingId,
      operationKind: event.data.intent,
      listingRevision: event.data.listingRevision,
      desiredStateSequence: event.data.desiredStateSequence,
      desiredStateHash: event.data.desiredStateHash,
      payload:
        event.data.intent === "delist"
          ? { kind: "delist", delist: event.data.delist }
          : { kind: "draft", draft: event.data.draft },
      envelope: {
        sourceEventId: source.id,
        sourceStreamId: source.streamId,
        sourceStreamVersion: source.streamVersion,
        sourceGlobalPosition: source.globalPosition,
        sourceOccurredAt: source.timing.occurredAt,
      },
    });
  };
  handlers["channels.channel-listing-reconciliation.run-settled"] = async () => {};
  return handlers;
}

async function findHoldItemId(db: PgQueryable, holdId: string): Promise<string | null> {
  const result = await db.query<{ item_id: string }>(
    `SELECT item_id FROM channels_inventory_hold_facts WHERE hold_id=$1`,
    [holdId],
  );
  return result.rows[0]?.item_id ?? null;
}
async function connectionsForInventoryItem(db: PgQueryable, itemId: string): Promise<readonly string[]> {
  const result = await db.query<{ connection_id: string }>(
    `SELECT DISTINCT connection.connection_id FROM channels_connection_facts AS connection
     JOIN channels_listing_publication_facts AS listing ON listing.account_id=connection.account_id
     WHERE listing.inventory_item_id=$1 ORDER BY connection.connection_id`,
    [itemId],
  );
  return result.rows.map((row) => row.connection_id);
}
function context(event: SignalEvent): EventStoreContext {
  return {
    tenantId: event.tenantId as EventStoreContext["tenantId"],
    audit: {
      performedByUserId: event.audit.performedByUserId as EventStoreContext["audit"]["performedByUserId"],
      forAccountId: event.audit.forAccountId as EventStoreContext["audit"]["forAccountId"],
    },
    trace: event.trace,
  };
}
