import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import { toJsonValue } from "@chase-sets/primitives/json";
import { pricingAuthorityDigest, pricingAuthorityResources as resource } from "./listing-authority-resources";

export const pricingObservationStream = (sourceStreamId: string) =>
  `pricing.evaluation-observation-${pricingAuthorityDigest(sourceStreamId)}`;

/** Source-only subscriptions to mount/replay before granting; existing consumer projections are unchanged. */
export const pricingAuthorityObservationEventTypes = {
  marketplace: [
    "marketplace.listing.created",
    "marketplace.listing.price-updated",
    "marketplace.listing.quantity-cap-updated",
    "marketplace.listing.purchase-limits-updated",
    "marketplace.listing.photos-added",
    "marketplace.listing.photo-classified",
    "marketplace.listing.photo-replaced",
    "marketplace.listing.photo-removed",
    "marketplace.listing.photos-reordered",
    "marketplace.listing.evidence-requirements-refreshed",
    "marketplace.listing.published",
    "marketplace.listing.paused",
    "marketplace.listing.auto-unlisted",
    "marketplace.listing.withdrawn",
    "marketplace.listing.offer-commitment-recorded",
    "marketplace.listing.inbound-clamp-engaged",
    "marketplace.listing.inbound-clamp-released",
    "marketplace.listing.inbound-clamp-ownership-adopted",
    "marketplace.listing.target-price-accepted",
    "marketplace.listing.channel-activated",
    "marketplace.listing.native-visibility-changed",
    "marketplace.listing.resumed",
  ],
  catalog: [
    "catalog.catalog-item.created",
    "catalog.catalog-item.category-assigned",
    "catalog.catalog-item.category-removed",
  ],
  inventory: ["inventory.item.created"],
} as const;

export async function readPricingObservations(store: EventStore, sourceStreamId: string) {
  const streamId = pricingObservationStream(sourceStreamId);
  const history = await readCompleteStream(store, { streamId });
  const events = history
    .map((event) => {
      if (event.eventType !== "pricing.evaluation-input.observed") throw new Error("Unknown Pricing input history.");
      const observed = event.payload.event as unknown as TransportEvent;
      if (
        observed.streamId !== sourceStreamId ||
        observed.tenantId !== event.tenantId ||
        observed.audit.forAccountId !== event.forAccountId ||
        observed.audit.performedByUserId !== event.performedByUserId ||
        !observed.id ||
        !Number.isSafeInteger(observed.streamVersion) ||
        observed.streamVersion < 1
      )
        throw new Error("Invalid Pricing input provenance.");
      return observed;
    })
    .sort((a, b) => a.streamVersion - b.streamVersion);
  if (new Set(events.map((event) => event.streamVersion)).size !== events.length)
    throw new Error("Duplicate Pricing input revision.");
  return { streamId, version: history.at(-1)?.streamVersion ?? 0, events };
}

/** Source-subscription adapter. Persist input provenance through the SAME guarded owner writer.
 * Projections remain disposable: neither their presence nor contents authorizes evaluation.
 */
export function createPricingAuthorityObservations(eventStore: EventStore) {
  const api = {
    async observe(event: TransportEvent) {
      if (
        !(
          event.streamId.startsWith("marketplace.listing-") ||
          event.streamId.startsWith("catalog.item-") ||
          event.streamId.startsWith("inventory.item-")
        )
      )
        return;
      const current = await readPricingObservations(eventStore, event.streamId);
      const prior = current.events.find((entry) => entry.streamVersion === event.streamVersion);
      if (prior) {
        if (pricingAuthorityDigest(prior) !== pricingAuthorityDigest(event))
          throw new Error("Pricing input revision was reused with different evidence.");
        return;
      }
      await eventStore.appendToStream({
        streamId: current.streamId,
        expectedVersion: current.version,
        context: { tenantId: event.tenantId, audit: event.audit },
        events: [{ eventType: "pricing.evaluation-input.observed", payload: { event: toJsonValue(event) } }],
      });
    },
  };
  return {
    ...api,
    handlers(owner: keyof typeof pricingAuthorityObservationEventTypes): ProjectorHandlerMap {
      return Object.fromEntries(pricingAuthorityObservationEventTypes[owner].map((type) => [type, api.observe]));
    },
  };
}

export function pricingObservationResources(events: readonly TransportEvent[]): readonly string[] {
  const resources = new Set<string>();
  for (const event of events) {
    if (event.streamId.startsWith("marketplace.listing-")) {
      resources.add(resource.listing(event.streamId.slice("marketplace.listing-".length)));
      if (typeof event.data.catalogItemId === "string" && typeof event.data.productId === "string")
        resources.add(resource.product(event.data.catalogItemId, event.data.productId));
    } else if (event.streamId.startsWith("catalog.item-")) {
      resources.add(resource.catalogItem(event.streamId.slice("catalog.item-".length)));
    } else if (event.streamId.startsWith("inventory.item-")) {
      resources.add(resource.inventoryItem(event.streamId.slice("inventory.item-".length)));
    } else throw new Error("Unknown Pricing observation owner.");
  }
  return [...resources];
}

export function pricingListingObservation(events: readonly TransportEvent[]) {
  if (events.some((event, index) => event.streamVersion !== index + 1))
    throw new Error("Pricing Listing observation history is incomplete; replay the missing source revisions.");
  const created = events.find((event) => event.type === "marketplace.listing.created");
  if (!created) return null;
  const data = created.data;
  if (
    typeof data.listingId !== "string" ||
    created.streamId !== `marketplace.listing-${data.listingId}` ||
    created.streamVersion !== 1 ||
    typeof data.accountId !== "string" ||
    typeof data.catalogItemId !== "string" ||
    typeof data.productId !== "string" ||
    typeof data.inventoryItemId !== "string" ||
    typeof data.priceAmount !== "string" ||
    typeof data.priceCurrencyCode !== "string" ||
    !Number.isSafeInteger(data.quantityCap)
  )
    throw new Error("Pricing Listing input is incomplete.");
  let priceAmount = data.priceAmount;
  let nativePriceRevision = created.streamVersion;
  let priceCurrencyCode = data.priceCurrencyCode;
  let quantityCap = data.quantityCap as number;
  let status: "draft" | "active" | "paused" | "withdrawn" = "draft";
  let pauseReason: string | null = null;
  let published = false;
  let nativeVisible =
    data.nativeVisibility === undefined
      ? data.publicationScope !== "channel-only"
      : data.nativeVisibility === "enabled";
  for (const event of events) {
    if (event.type === "marketplace.listing.price-updated") {
      if (typeof event.data.priceAmount !== "string" || typeof event.data.priceCurrencyCode !== "string")
        throw new Error("Pricing native reference pair is incomplete.");
      priceAmount = event.data.priceAmount;
      priceCurrencyCode = event.data.priceCurrencyCode;
      nativePriceRevision = event.streamVersion;
    } else if (event.type === "marketplace.listing.quantity-cap-updated") {
      if (!Number.isSafeInteger(event.data.quantityCap)) throw new Error("Invalid Pricing quantity input.");
      quantityCap = event.data.quantityCap as number;
    } else if (event.type === "marketplace.listing.published") {
      status = "active";
      published = true;
      pauseReason = null;
    } else if (event.type === "marketplace.listing.channel-activated" || event.type === "marketplace.listing.resumed") {
      if (status !== "withdrawn") {
        status = "active";
        pauseReason = null;
      }
    } else if (event.type === "marketplace.listing.native-visibility-changed") {
      nativeVisible = event.data.nativeVisibility === "enabled";
    } else if (event.type === "marketplace.listing.inbound-clamp-engaged") {
      status = "paused";
      pauseReason = "channel-inbound-dark";
    } else if (event.type === "marketplace.listing.paused") {
      status = "paused";
      pauseReason = typeof event.data.reason === "string" ? event.data.reason : "seller";
    } else if (event.type === "marketplace.listing.withdrawn") status = "withdrawn";
    else if (event.type === "marketplace.listing.auto-unlisted") {
      status = "paused";
      pauseReason = "auto-unlisted";
    }
    // Per-target accepted leaves/readback NEVER replace the native reference or enter asks.
  }
  return {
    listingId: data.listingId,
    sellerAccountId: data.accountId,
    catalogItemId: data.catalogItemId,
    productId: data.productId,
    inventoryItemId: data.inventoryItemId,
    priceAmount,
    nativePriceRevision,
    priceCurrencyCode,
    quantityCap,
    listingVersion: events.at(-1)!.streamVersion,
    status,
    pauseReason,
    grading: data.gradedCard ? ("graded" as const) : ("raw" as const),
    createdAt: created.timing.recordedAt,
    nativeAsk: status === "active" && published && nativeVisible,
    publicationScope: data.publicationScope === "channel-only" ? ("channel-only" as const) : ("native" as const),
  };
}

export function pricingCatalogCategories(events: readonly TransportEvent[]): readonly string[] {
  if (!events.some((event) => event.type === "catalog.catalog-item.created"))
    throw new Error("Pricing Catalog input is incomplete.");
  const categories = new Set<string>();
  for (const event of events) {
    if (
      event.type === "catalog.catalog-item.category-assigned" ||
      event.type === "catalog.catalog-item.category-removed"
    ) {
      if (typeof event.data.categoryId !== "string") throw new Error("Pricing category evidence is incomplete.");
      if (event.type.endsWith(".category-assigned")) categories.add(event.data.categoryId);
      else categories.delete(event.data.categoryId);
    }
  }
  return [...categories].sort();
}

export function pricingInventoryCost(events: readonly TransportEvent[], accountId: string) {
  const created = events.find((event) => event.type === "inventory.item.created");
  if (!created || created.data.accountId !== accountId)
    throw new Error("Pricing Inventory input is incomplete or foreign.");
  const amount = created.data.acquisitionCostAmount ?? null;
  const currencyCode = created.data.acquisitionCostCurrencyCode ?? null;
  if ((amount !== null && typeof amount !== "string") || (currencyCode !== null && typeof currencyCode !== "string"))
    throw new Error("Pricing cost evidence is malformed.");
  return { amount, currencyCode };
}
