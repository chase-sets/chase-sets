import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext, StoredEvent } from "@chase-sets/event-core/storage";
import { toJsonValue, type JsonObject } from "@chase-sets/primitives/json";
import {
  assembleProductMeasurePublication,
  assertProductMeasurePublicationIdentity,
  digestProductMeasures,
  productMeasurePublicationCompleted,
  productMeasurePublicationPartRecorded,
  ProductMeasurePublicationError,
  type ProductMeasureSnapshot,
} from "@chase-sets/product-measures";

const publicationPayloadBudgetBytes = 64_512;
const legacyResolvedEventType = "catalog.catalog-item.product-measures-resolved";
const encoder = new TextEncoder();

export class ProductMeasurePublicationTooLargeError extends Error {
  readonly code = "product_measure_publication_too_large";

  constructor(
    readonly catalogItemId: string,
    readonly productId: string | null,
    readonly payloadBytes: number,
  ) {
    super(
      `Product Measure Publication exceeds ${publicationPayloadBudgetBytes} bytes${productId ? ` for Product ${productId}` : ""}.`,
    );
    this.name = "ProductMeasurePublicationTooLargeError";
  }
}

export async function publishProductMeasures(
  eventStore: EventStore,
  catalogItemId: string,
  products: readonly ProductMeasureSnapshot[],
  context: EventStoreContext,
): Promise<void> {
  const streamId = `catalog.product-measures-${catalogItemId}`;
  const history = await readCompleteStream(eventStore, { streamId });
  const payload = { catalogItemId, products: toJsonValue(products) } as JsonObject;
  const current = await latestCompletePublication(history, catalogItemId);
  if (current && jsonValuesEqual(current, payload)) return;

  const events = await publicationEvents(catalogItemId, products, payload);
  await eventStore.appendToStream({
    streamId,
    expectedVersion: history.at(-1)?.streamVersion ?? 0,
    context,
    events,
  });
}

async function latestCompletePublication(history: readonly StoredEvent[], catalogItemId: string): Promise<unknown> {
  const last = [...history]
    .reverse()
    .find((event) =>
      [legacyResolvedEventType, productMeasurePublicationPartRecorded, productMeasurePublicationCompleted].includes(
        event.eventType,
      ),
    );
  if (!last || last.eventType === productMeasurePublicationPartRecorded) return null;
  try {
    assertProductMeasurePublicationIdentity({ ...last, data: last.payload }, catalogItemId);
    if (last.eventType === legacyResolvedEventType) return last.payload;
    const partCount = last.payload.partCount;
    if (!Number.isSafeInteger(partCount) || Number(partCount) < 1) return null;
    const parts = history.filter(
      (event) =>
        event.streamVersion >= last.streamVersion - Number(partCount) && event.streamVersion < last.streamVersion,
    );
    if (parts.some((event) => event.eventType !== productMeasurePublicationPartRecorded)) return null;
    const products = await assembleProductMeasurePublication(
      { ...last, data: last.payload },
      parts.map((event) => ({ ...event, data: event.payload })),
    );
    if (last.payload.catalogItemId !== catalogItemId) return null;
    return { catalogItemId, products };
  } catch (error) {
    if (error instanceof ProductMeasurePublicationError) return null;
    throw error;
  }
}

async function publicationEvents(
  catalogItemId: string,
  products: readonly ProductMeasureSnapshot[],
  legacyPayload: JsonObject,
) {
  if (payloadBytes(legacyPayload) <= publicationPayloadBudgetBytes) {
    return [{ eventType: legacyResolvedEventType, payload: legacyPayload }];
  }
  const events: { eventType: string; payload: JsonObject }[] = [];
  let part: ProductMeasureSnapshot[] = [];
  let partBytes = payloadBytes({ catalogItemId, partIndex: 0, products: [] });
  const flushPart = () => {
    events.push({
      eventType: productMeasurePublicationPartRecorded,
      payload: { catalogItemId, partIndex: events.length, products: toJsonValue(part) },
    });
    part = [];
    partBytes = payloadBytes({ catalogItemId, partIndex: events.length, products: [] });
  };
  for (const product of products) {
    const productBytes = payloadBytes(product);
    if (part.length > 0 && partBytes + productBytes + 1 > publicationPayloadBudgetBytes) flushPart();
    const nextBytes = partBytes + productBytes + (part.length > 0 ? 1 : 0);
    if (nextBytes > publicationPayloadBudgetBytes) {
      throw new ProductMeasurePublicationTooLargeError(catalogItemId, product.productId, nextBytes);
    }
    part.push(product);
    partBytes = nextBytes;
  }
  if (part.length > 0) flushPart();
  const completion: JsonObject = {
    catalogItemId,
    partCount: events.length,
    productCount: products.length,
    productsDigest: await digestProductMeasures(products),
  };
  const completionBytes = payloadBytes(completion);
  if (completionBytes > publicationPayloadBudgetBytes || events.length === 0) {
    throw new ProductMeasurePublicationTooLargeError(catalogItemId, null, completionBytes);
  }
  events.push({ eventType: productMeasurePublicationCompleted, payload: completion });
  return events;
}

function payloadBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).byteLength;
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(sortJson(left)) === JSON.stringify(sortJson(right));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortJson(entry)]),
    );
  }
  return value;
}
