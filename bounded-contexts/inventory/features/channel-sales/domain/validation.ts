import { createHash } from "node:crypto";
import type { InventoryExternalChannelSaleRecordedPayload } from "@chase-sets/event-core/public-event-payloads";
import { isCanonicalMoneyAmount } from "@chase-sets/primitives/money";
import { InventoryDomainError } from "../../../support/runtime-support/common";
import type { ExternalChannelSaleKeyV1, RecordExternalChannelSaleCommand } from "../api/contracts";

export const EXTERNAL_CHANNEL_SALE_COLLISION_POLICY_REF =
  "https://github.com/chase-sets/chase-sets/issues/7354#issuecomment-5381318708";
export const EXTERNAL_CHANNEL_SALE_COLLISION_POLICY_REVISION = 1;
export const EXTERNAL_CHANNEL_SALE_REASON_CODE = "sold-external-channel" as const;
export const EXTERNAL_CHANNEL_SALE_COLLISION_MODE = "protect-orders" as const;
export const EXTERNAL_CHANNEL_SALE_EVENT_TYPE = "inventory.external-channel-sale.recorded" as const;
export const EXTERNAL_CHANNEL_SALE_EVENT_VERSION = 1 as const;

const COMMAND_KEYS = [
  "accountId",
  "inventoryItemId",
  "storageLocationId",
  "saleKey",
  "requestedQuantity",
  "unitPriceAmount",
  "currencyCode",
  "soldAt",
  "connectionAuditReference",
] as const;
const KEY_KEYS = ["version", "providerKey", "sellerEnvironmentLineage", "orderLineIdentity"] as const;
const EVENT_KEYS = [
  "eventVersion",
  "saleKey",
  "commandFingerprint",
  "accountId",
  "inventoryItemId",
  "storageLocationId",
  "requestedQuantity",
  "unitPriceAmount",
  "currencyCode",
  "soldAt",
  "connectionAuditReference",
  "collisionMode",
  "collisionPolicyRef",
  "collisionPolicyRevision",
  "reasonCode",
  "result",
] as const;
const RESULT_KEYS = [
  "saleKey",
  "saleStreamId",
  "saleEventId",
  "accountId",
  "inventoryItemId",
  "storageLocationId",
  "requestedQuantity",
  "appliedQuantity",
  "refusedQuantity",
  "protectedOrderIds",
  "collisionPolicyRef",
  "collisionPolicyRevision",
  "inventoryAdjustmentEventId",
  "saleShortfallKey",
  "committedAt",
] as const;

export type NormalizedExternalChannelSaleCommand = Readonly<{
  accountId: string;
  inventoryItemId: string;
  storageLocationId: string;
  saleKey: ExternalChannelSaleKeyV1;
  requestedQuantity: number;
  unitPriceAmount?: string;
  currencyCode?: string;
  soldAt?: string;
  connectionAuditReference?: string;
}>;

export function normalizeExternalChannelSaleCommand(
  value: RecordExternalChannelSaleCommand,
): NormalizedExternalChannelSaleCommand {
  const command = requireClosedRecord(value, COMMAND_KEYS, "External channel sale command");
  const saleKey = parseExternalChannelSaleKey(command.saleKey);
  const accountId = requireReference(command.accountId, "accountId");
  const inventoryItemId = requireReference(command.inventoryItemId, "inventoryItemId");
  const storageLocationId = requireReference(command.storageLocationId, "storageLocationId");
  const requestedQuantity = command.requestedQuantity;
  if (
    typeof requestedQuantity !== "number" ||
    !Number.isInteger(requestedQuantity) ||
    requestedQuantity < 1 ||
    requestedQuantity > 2_147_483_647
  ) {
    throw new InventoryDomainError(
      "External channel sale requestedQuantity must be an integer from 1 through 2147483647.",
    );
  }

  const hasAmount = Object.hasOwn(command, "unitPriceAmount");
  const hasCurrency = Object.hasOwn(command, "currencyCode");
  if (hasAmount !== hasCurrency) {
    throw new InventoryDomainError(
      "External channel sale unitPriceAmount and currencyCode must both be present or both be absent.",
    );
  }
  let unitPriceAmount: string | undefined;
  let currencyCode: string | undefined;
  if (hasAmount) {
    if (typeof command.unitPriceAmount !== "string" || !isCanonicalMoneyAmount(command.unitPriceAmount)) {
      throw new InventoryDomainError("External channel sale unitPriceAmount must be a canonical MoneyAmount.");
    }
    unitPriceAmount = command.unitPriceAmount;
  }
  if (hasCurrency) {
    if (typeof command.currencyCode !== "string" || !/^[A-Z]{3}$/.test(command.currencyCode)) {
      throw new InventoryDomainError("External channel sale currencyCode must be three uppercase ASCII letters.");
    }
    currencyCode = command.currencyCode;
  }

  const soldAt = Object.hasOwn(command, "soldAt") ? normalizeRfc3339Instant(command.soldAt, "soldAt") : undefined;
  const connectionAuditReference = Object.hasOwn(command, "connectionAuditReference")
    ? requireReference(command.connectionAuditReference, "connectionAuditReference")
    : undefined;

  return {
    accountId,
    inventoryItemId,
    storageLocationId,
    saleKey,
    requestedQuantity,
    ...(unitPriceAmount !== undefined ? { unitPriceAmount } : {}),
    ...(currencyCode !== undefined ? { currencyCode } : {}),
    ...(soldAt !== undefined ? { soldAt } : {}),
    ...(connectionAuditReference !== undefined ? { connectionAuditReference } : {}),
  };
}

export function parseExternalChannelSaleKey(value: unknown): ExternalChannelSaleKeyV1 {
  const key = requireClosedRecord(value, KEY_KEYS, "ExternalChannelSaleKey/v1");
  if (key.version !== "v1") {
    throw new InventoryDomainError("External channel sale key version must be v1.");
  }
  if (typeof key.providerKey !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(key.providerKey)) {
    throw new InventoryDomainError("External channel sale providerKey must be canonical lower-kebab ASCII.");
  }
  return {
    version: "v1",
    providerKey: key.providerKey,
    sellerEnvironmentLineage: requireOpaqueKeyPart(key.sellerEnvironmentLineage, "sellerEnvironmentLineage"),
    orderLineIdentity: requireOpaqueKeyPart(key.orderLineIdentity, "orderLineIdentity"),
  };
}

export function externalChannelSaleCanonicalKeyBytes(key: ExternalChannelSaleKeyV1): Buffer {
  const fields = [key.providerKey, key.sellerEnvironmentLineage, key.orderLineIdentity].map((field) =>
    Buffer.from(field, "utf8"),
  );
  const parts: Buffer[] = [Buffer.from("ExternalChannelSaleKey/v1", "utf8")];
  for (const field of fields) {
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(field.byteLength);
    parts.push(length, field);
  }
  return Buffer.concat(parts);
}

export function externalChannelSaleStreamId(key: ExternalChannelSaleKeyV1): string {
  const digest = createHash("sha256").update(externalChannelSaleCanonicalKeyBytes(key)).digest("base64url");
  return `inventory.external-channel-sale-v1-${digest}`;
}

export function externalChannelSaleShortfallKey(key: ExternalChannelSaleKeyV1, commandFingerprint: string): string {
  const revision = Buffer.allocUnsafe(4);
  revision.writeUInt32BE(EXTERNAL_CHANNEL_SALE_COLLISION_POLICY_REVISION);
  const digest = createHash("sha256")
    .update(Buffer.from("ExternalChannelSaleShortfall/v1", "utf8"))
    .update(externalChannelSaleCanonicalKeyBytes(key))
    .update(revision)
    .update(Buffer.from(commandFingerprint, "ascii"))
    .digest("base64url");
  return `inventory.sale-shortfall-v1-${digest}`;
}

export function isClosedExternalChannelSaleEventPayload(
  value: unknown,
): value is InventoryExternalChannelSaleRecordedPayload {
  if (
    !isClosedRecord(value, EVENT_KEYS) ||
    !isClosedRecord(value.saleKey, KEY_KEYS) ||
    !isClosedRecord(value.result, RESULT_KEYS) ||
    !isClosedRecord(value.result.saleKey, KEY_KEYS)
  ) {
    return false;
  }
  if (!Array.isArray(value.result.protectedOrderIds)) {
    return false;
  }
  try {
    parseExternalChannelSaleKey(value.saleKey);
  } catch {
    return false;
  }
  return true;
}

export function isCanonicalUtcInstant(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

export function isValidReference(value: unknown): value is string {
  return typeof value === "string" && validUnicode(value, 128, "scalars") && value.trim() === value;
}

function requireOpaqueKeyPart(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || !validUnicode(value, 256, "bytes") || value.trim() !== value) {
    throw new InventoryDomainError(`External channel sale ${fieldName} is invalid.`);
  }
  return value;
}

function requireReference(value: unknown, fieldName: string): string {
  if (!isValidReference(value)) {
    throw new InventoryDomainError(`External channel sale ${fieldName} is invalid.`);
  }
  return value;
}

function validUnicode(value: string, maximum: number, measure: "bytes" | "scalars"): boolean {
  if (value.length === 0 || value.normalize("NFC") !== value) {
    return false;
  }
  const codePoints = Array.from(value, (character) => character.codePointAt(0)!);
  if (codePoints.some(isForbiddenCodePoint)) {
    return false;
  }
  const length = measure === "bytes" ? Buffer.byteLength(value, "utf8") : codePoints.length;
  return length >= 1 && length <= maximum;
}

function isForbiddenCodePoint(codePoint: number): boolean {
  return (
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
    (codePoint >= 0xfdd0 && codePoint <= 0xfdef) ||
    (codePoint & 0xffff) === 0xfffe ||
    (codePoint & 0xffff) === 0xffff
  );
}

function normalizeRfc3339Instant(value: unknown, fieldName: string): string {
  if (typeof value !== "string") {
    throw new InventoryDomainError(`External channel sale ${fieldName} must be an RFC 3339 instant.`);
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) {
    throw new InventoryDomainError(`External channel sale ${fieldName} must include seconds and a timezone.`);
  }
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  calendar.setUTCHours(hour, minute, second, 0);
  if (
    year < 1 ||
    year > 9999 ||
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day ||
    calendar.getUTCHours() !== hour ||
    calendar.getUTCMinutes() !== minute ||
    calendar.getUTCSeconds() !== second
  ) {
    throw new InventoryDomainError(`External channel sale ${fieldName} is not a valid calendar instant.`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new InventoryDomainError(`External channel sale ${fieldName} is outside the supported timestamp range.`);
  }
  return new Date(parsed).toISOString();
}

function isClosedRecord(value: unknown, allowedKeys: readonly string[]): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => allowedKeys.includes(key))
  );
}

function requireClosedRecord(value: unknown, allowedKeys: readonly string[], label: string): Record<string, unknown> {
  if (!isClosedRecord(value, allowedKeys)) {
    throw new InventoryDomainError(`${label} contains an unknown field or is not an object.`);
  }
  return value;
}
