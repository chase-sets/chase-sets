import { ChannelConnectionError } from "../../connections/domain/contracts";
import {
  assertChannelEnvironment,
  assertClosedRecord,
  assertOpaqueId,
  assertProviderKey,
  assertSafeInteger,
} from "../../connections/domain/validation";
import {
  channelPublicationRejectionCodes,
  type ChannelProviderIdentity,
  type ChannelPublicationAttribute,
  type ChannelPublicationDraft,
  type ChannelPublicationPrice,
  type ChannelPublicationResult,
  type ChannelSaleFetchResult,
  type ChannelStateFetchResult,
  type DelistListingInput,
  type PublishListingInput,
  type UpdatePriceQuantityInput,
} from "./contracts";

const CURRENCY = /^[A-Z]{3}$/;

export function assertChannelProviderIdentity(
  value: unknown,
  label = "provider identity",
): asserts value is ChannelProviderIdentity {
  assertClosedRecord(value, ["providerKey", "environment"], label);
  assertProviderKey(value.providerKey);
  assertChannelEnvironment(value.environment);
}

export function assertChannelPublicationPrice(
  value: unknown,
  label = "price",
): asserts value is ChannelPublicationPrice {
  assertClosedRecord(value, ["amountMinor", "currency"], label);
  assertSafeInteger(value.amountMinor, `${label}.amountMinor`);
  if (typeof value.currency !== "string" || !CURRENCY.test(value.currency)) {
    invalid(`${label}.currency must be three uppercase ASCII letters.`);
  }
}

export function assertChannelPublicationAttribute(
  value: unknown,
  label = "attribute",
): asserts value is ChannelPublicationAttribute {
  assertClosedRecord(value, ["key", "value"], label);
  assertScalarString(value.key, 1, 256, `${label}.key`);
  assertScalarString(value.value, 0, 4_096, `${label}.value`);
}

export function assertChannelPublicationDraft(
  value: unknown,
  label = "draft",
): asserts value is ChannelPublicationDraft {
  assertClosedRecord(
    value,
    [
      "channelListingId",
      "listingRevision",
      "title",
      "description",
      "categoryKey",
      "conditionKey",
      "price",
      "quantity",
      "attributes",
    ],
    label,
  );
  assertOpaqueId(value.channelListingId, `${label}.channelListingId`);
  assertSafeInteger(value.listingRevision, `${label}.listingRevision`);
  assertScalarString(value.title, 1, 4_096, `${label}.title`);
  assertScalarString(value.description, 0, 100_000, `${label}.description`);
  assertScalarString(value.categoryKey, 1, 256, `${label}.categoryKey`);
  assertScalarString(value.conditionKey, 1, 256, `${label}.conditionKey`);
  assertChannelPublicationPrice(value.price, `${label}.price`);
  assertBoundedQuantity(value.quantity, `${label}.quantity`);
  if (!Array.isArray(value.attributes) || value.attributes.length > 200) {
    invalid(`${label}.attributes must contain zero to 200 entries.`);
  }
  const keys = new Set<string>();
  for (const [index, attribute] of value.attributes.entries()) {
    assertChannelPublicationAttribute(attribute, `${label}.attributes[${index}]`);
    if (keys.has(attribute.key)) invalid(`${label}.attributes must have unique exact keys.`);
    keys.add(attribute.key);
  }
}

export function assertPublishListingInput(value: unknown): asserts value is PublishListingInput {
  assertClosedRecord(value, ["operationId", "connectionId", "draft"], "publishListing input");
  assertOpaqueId(value.operationId, "publishListing input.operationId");
  assertOpaqueId(value.connectionId, "publishListing input.connectionId");
  assertChannelPublicationDraft(value.draft, "publishListing input.draft");
}

export function assertUpdatePriceQuantityInput(value: unknown): asserts value is UpdatePriceQuantityInput {
  assertClosedRecord(
    value,
    ["operationId", "connectionId", "channelListingId", "listingRevision", "price", "quantity"],
    "updatePriceQuantity input",
  );
  assertOpaqueId(value.operationId, "updatePriceQuantity input.operationId");
  assertOpaqueId(value.connectionId, "updatePriceQuantity input.connectionId");
  assertOpaqueId(value.channelListingId, "updatePriceQuantity input.channelListingId");
  assertSafeInteger(value.listingRevision, "updatePriceQuantity input.listingRevision");
  assertChannelPublicationPrice(value.price, "updatePriceQuantity input.price");
  assertBoundedQuantity(value.quantity, "updatePriceQuantity input.quantity");
}

export function assertDelistListingInput(value: unknown): asserts value is DelistListingInput {
  assertClosedRecord(
    value,
    ["operationId", "connectionId", "channelListingId", "listingRevision"],
    "delistListing input",
  );
  assertOpaqueId(value.operationId, "delistListing input.operationId");
  assertOpaqueId(value.connectionId, "delistListing input.connectionId");
  assertOpaqueId(value.channelListingId, "delistListing input.channelListingId");
  assertSafeInteger(value.listingRevision, "delistListing input.listingRevision");
}

export function assertChannelPublicationResult(
  value: unknown,
  label = "provider result",
): asserts value is ChannelPublicationResult {
  assertClosedRecord(value, ["kind", "externalListingId", "externalOfferId", "providerRevision", "code"], label);
  if (value.kind === "succeeded") {
    assertClosedRecord(value, ["kind", "externalListingId", "externalOfferId", "providerRevision"], label);
    assertScalarString(value.externalListingId, 1, 512, `${label}.externalListingId`);
    if (Object.hasOwn(value, "externalOfferId")) {
      assertScalarString(value.externalOfferId, 1, 512, `${label}.externalOfferId`);
    }
    if (Object.hasOwn(value, "providerRevision")) {
      assertScalarString(value.providerRevision, 1, 512, `${label}.providerRevision`);
    }
    return;
  }
  if (value.kind === "rejected") {
    assertClosedRecord(value, ["kind", "code"], label);
    if (!channelPublicationRejectionCodes.includes(value.code as never)) {
      invalid(`${label}.code is invalid.`);
    }
    return;
  }
  invalid(`${label}.kind is invalid.`);
}

export function assertChannelStateFetchResult(value: unknown): asserts value is ChannelStateFetchResult {
  const result = assertBoundedFetchResult(value, "channel state result", "items");
  if (result.kind === "bounded-unknown") return;
  const items = result.items as unknown[];
  const identities = new Set<string>();
  for (const [index, candidate] of items.entries()) {
    const label = `channel state result.items[${index}]`;
    assertClosedRecord(
      candidate,
      ["externalListingId", "externalOfferId", "revision", "price", "quantity", "fingerprint"],
      label,
    );
    assertScalarString(candidate.externalListingId, 1, 512, `${label}.externalListingId`);
    if (candidate.externalOfferId !== null)
      assertScalarString(candidate.externalOfferId, 1, 512, `${label}.externalOfferId`);
    assertScalarString(candidate.revision, 1, 512, `${label}.revision`);
    assertChannelPublicationPrice(candidate.price, `${label}.price`);
    assertBoundedQuantity(candidate.quantity, `${label}.quantity`);
    if (typeof candidate.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(candidate.fingerprint)) {
      invalid(`${label}.fingerprint is invalid.`);
    }
    const identity = `${candidate.externalListingId}\u0000${candidate.externalOfferId ?? ""}`;
    if (identities.has(identity)) invalid("channel state result contains a duplicate identity.");
    identities.add(identity);
  }
}

export function assertChannelSaleFetchResult(value: unknown): asserts value is ChannelSaleFetchResult {
  const result = assertBoundedFetchResult(value, "channel sale result", "lines");
  if (result.kind === "bounded-unknown") return;
  const lines = result.lines as unknown[];
  const identities = new Set<string>();
  for (const [index, candidate] of lines.entries()) {
    const label = `channel sale result.lines[${index}]`;
    assertClosedRecord(
      candidate,
      [
        "saleKey",
        "externalListingId",
        "externalOfferId",
        "requestedQuantity",
        "unitPriceAmount",
        "currencyCode",
        "soldAt",
      ],
      label,
    );
    assertClosedRecord(
      candidate.saleKey,
      ["version", "providerKey", "sellerEnvironmentLineage", "orderLineIdentity"],
      `${label}.saleKey`,
    );
    if (candidate.saleKey.version !== "v1") invalid(`${label}.saleKey.version is invalid.`);
    for (const key of ["providerKey", "sellerEnvironmentLineage", "orderLineIdentity"] as const) {
      assertScalarString(candidate.saleKey[key], 1, 512, `${label}.saleKey.${key}`);
    }
    assertScalarString(candidate.externalListingId, 1, 512, `${label}.externalListingId`);
    if (candidate.externalOfferId !== null)
      assertScalarString(candidate.externalOfferId, 1, 512, `${label}.externalOfferId`);
    if (
      !Number.isSafeInteger(candidate.requestedQuantity) ||
      Number(candidate.requestedQuantity) < 1 ||
      Number(candidate.requestedQuantity) > 1_000_000
    ) {
      invalid(`${label}.requestedQuantity must be an integer from 1 to 1000000.`);
    }
    const hasPrice = Object.hasOwn(candidate, "unitPriceAmount");
    const hasCurrency = Object.hasOwn(candidate, "currencyCode");
    if (hasPrice !== hasCurrency) invalid(`${label}.unitPriceAmount and currencyCode must be paired.`);
    if (hasPrice) assertScalarString(candidate.unitPriceAmount, 1, 128, `${label}.unitPriceAmount`);
    if (hasCurrency && (typeof candidate.currencyCode !== "string" || !CURRENCY.test(candidate.currencyCode))) {
      invalid(`${label}.currencyCode is invalid.`);
    }
    if (Object.hasOwn(candidate, "soldAt")) assertCanonicalInstant(candidate.soldAt, `${label}.soldAt`);
    const identity = JSON.stringify(candidate.saleKey);
    if (identities.has(identity)) invalid("channel sale result contains a duplicate sale key.");
    identities.add(identity);
  }
}

function assertBoundedFetchResult(
  value: unknown,
  label: string,
  collectionKey: "items" | "lines",
): Record<string, unknown> {
  assertClosedRecord(value, ["kind", collectionKey, "collectedCount", "authorityTotal", "pageCount", "reason"], label);
  if (value.kind === "bounded-unknown") {
    assertClosedRecord(value, ["kind", "reason"], label);
    if (
      ![
        "hard-cap",
        "authority-total-mismatch",
        "unsafe-next-link",
        "duplicate-identity",
        "missing-identity",
        "missing-authority-total",
        "source-error",
      ].includes(String(value.reason))
    )
      invalid(`${label}.reason is invalid.`);
    return value;
  }
  if (value.kind !== "complete") invalid(`${label}.kind is invalid.`);
  assertClosedRecord(value, ["kind", collectionKey, "collectedCount", "authorityTotal", "pageCount"], label);
  const collection = value[collectionKey];
  if (!Array.isArray(collection) || collection.length > 100_000) invalid(`${label}.${collectionKey} is invalid.`);
  for (const key of ["collectedCount", "authorityTotal", "pageCount"] as const) {
    if (!Number.isSafeInteger(value[key]) || Number(value[key]) < (key === "pageCount" ? 1 : 0))
      invalid(`${label}.${key} is invalid.`);
  }
  if (value.collectedCount !== collection.length || value.collectedCount !== value.authorityTotal) {
    invalid(`${label} completeness counts do not reconcile.`);
  }
  return value;
}

function assertBoundedQuantity(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 1_000_000) {
    invalid(`${label} must be an integer from 0 to 1000000.`);
  }
}

function assertScalarString(value: unknown, minimum: number, maximum: number, label: string): asserts value is string {
  if (typeof value !== "string" || !isScalarString(value)) {
    invalid(`${label} must contain ${minimum} to ${maximum} Unicode scalars.`);
  }
  const length = [...value].length;
  if (length < minimum || length > maximum) {
    invalid(`${label} must contain ${minimum} to ${maximum} Unicode scalars.`);
  }
}

function isScalarString(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) return false;
  }
  return true;
}

export function assertCanonicalInstant(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) ||
    new Date(value).toISOString() !== value
  ) {
    invalid(`${label} must be a canonical UTC instant.`);
  }
}

function invalid(message: string): never {
  throw new ChannelConnectionError("invalid-input", message);
}
