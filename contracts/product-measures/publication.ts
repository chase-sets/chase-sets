import type { ProductMeasureSnapshot } from "./index";

export const productMeasurePublicationPartRecorded = "catalog.catalog-item.product-measures-publication-part-recorded";
export const productMeasurePublicationCompleted = "catalog.catalog-item.product-measures-publication-completed";

export type ProductMeasurePublicationPart = Readonly<{
  catalogItemId: string;
  partIndex: number;
  products: readonly ProductMeasureSnapshot[];
}>;

export type ProductMeasurePublicationCompletion = Readonly<{
  catalogItemId: string;
  partCount: number;
  productCount: number;
  productsDigest: string;
}>;

export type ProductMeasurePublicationEvent = Readonly<{
  streamId: string;
  streamVersion: number;
  data: unknown;
}>;

export class ProductMeasurePublicationError extends Error {
  readonly code = "invalid_product_measure_publication";
  readonly reason: string;

  constructor(reason: string) {
    super(`Invalid Product Measure Publication: ${reason}`);
    this.name = "ProductMeasurePublicationError";
    this.reason = reason;
  }
}

function fail(reason: string): never {
  throw new ProductMeasurePublicationError(reason);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid payload");
  return value as Record<string, unknown>;
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function integer(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function validateSnapshot(value: unknown, catalogItemId: string): asserts value is ProductMeasureSnapshot {
  const product = record(value);
  if (product.catalogItemId !== catalogItemId || !nonempty(product.productId)) fail("Product identity mismatch");
  if (!nonempty(product.measureVersion)) fail("invalid measure version");
  for (const key of ["unitLengthInches", "unitWidthInches", "unitHeightInches", "unitWeightOunces"]) {
    if (typeof product[key] !== "number" || !Number.isFinite(product[key]) || product[key] < 0) {
      fail("invalid physical measure");
    }
  }
  if (!Array.isArray(product.selectedOptions)) fail("invalid selected Options");
  for (const option of product.selectedOptions) {
    const selected = record(option);
    if (!nonempty(selected.dimensionId) || !nonempty(selected.optionId)) fail("invalid selected Option");
  }
  if (
    !Array.isArray(product.physicalFlags) ||
    !product.physicalFlags.every((flag) =>
      ["raw-card", "slab", "sealed", "rigid", "bendable", "metal", "jumbo", "irregular"].includes(flag),
    )
  )
    fail("invalid physical flags");
  if (
    typeof product.stackBehavior !== "string" ||
    !["stackable-thickness", "stackable-height", "non-stackable"].includes(product.stackBehavior)
  )
    fail("invalid stack behavior");
  if (
    typeof product.source !== "string" ||
    !["profile", "catalog-item-override", "product-override"].includes(product.source)
  )
    fail("invalid measure source");
  if (
    typeof product.confidence !== "string" ||
    !["measured", "provider", "conservative-estimate"].includes(product.confidence)
  )
    fail("invalid measure confidence");
}

export function parseProductMeasurePublicationPart(value: unknown): ProductMeasurePublicationPart {
  const data = record(value);
  if (!nonempty(data.catalogItemId) || !integer(data.partIndex, 0) || !Array.isArray(data.products))
    fail("invalid part payload");
  for (const product of data.products) validateSnapshot(product, data.catalogItemId);
  return data as ProductMeasurePublicationPart;
}

export function parseProductMeasurePublicationCompletion(value: unknown): ProductMeasurePublicationCompletion {
  const data = record(value);
  if (
    !nonempty(data.catalogItemId) ||
    !integer(data.partCount, 1) ||
    !integer(data.productCount, 0) ||
    typeof data.productsDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(data.productsDigest)
  )
    fail("invalid completion payload");
  return data as ProductMeasurePublicationCompletion;
}

export function assertProductMeasurePublicationIdentity(
  event: ProductMeasurePublicationEvent,
  catalogItemId: string,
): void {
  if (event.streamId !== `catalog.product-measures-${catalogItemId}` || !integer(event.streamVersion, 1))
    fail("stream/item identity mismatch");
}

function compareCodepoints(left: string, right: string): number {
  const a = Array.from(left, (character) => character.codePointAt(0)!);
  const b = Array.from(right, (character) => character.codePointAt(0)!);
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return a.length - b.length;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort(compareCodepoints)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  return fail("non-JSON measure value");
}

export async function digestProductMeasures(products: readonly ProductMeasureSnapshot[]): Promise<string> {
  const canonical = canonicalJson(
    [...products].sort((left, right) => compareCodepoints(left.productId, right.productId)),
  );
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function assembleProductMeasurePublication(
  completion: ProductMeasurePublicationEvent,
  parts: readonly ProductMeasurePublicationEvent[],
): Promise<readonly ProductMeasureSnapshot[]> {
  const data = parseProductMeasurePublicationCompletion(completion.data);
  assertProductMeasurePublicationIdentity(completion, data.catalogItemId);
  if (parts.length !== data.partCount || completion.streamVersion <= data.partCount) fail("missing or duplicate part");
  const ordered = [...parts].sort((left, right) => left.streamVersion - right.streamVersion);
  const products: ProductMeasureSnapshot[] = [];
  const ids = new Set<string>();
  for (const [index, event] of ordered.entries()) {
    assertProductMeasurePublicationIdentity(event, data.catalogItemId);
    const part = parseProductMeasurePublicationPart(event.data);
    if (part.catalogItemId !== data.catalogItemId) fail("part item mismatch");
    if (part.partIndex !== index || event.streamVersion !== completion.streamVersion - data.partCount + index)
      fail("noncontiguous part indices or versions");
    for (const product of part.products) {
      if (ids.has(product.productId)) fail("duplicate Product ID");
      ids.add(product.productId);
      products.push(product);
    }
  }
  if (products.length !== data.productCount) fail("Product count mismatch");
  if ((await digestProductMeasures(products)) !== data.productsDigest) fail("Product digest mismatch");
  return products;
}
