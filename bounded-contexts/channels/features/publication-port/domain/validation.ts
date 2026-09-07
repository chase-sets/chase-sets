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

function invalid(message: string): never {
  throw new ChannelConnectionError("invalid-input", message);
}
