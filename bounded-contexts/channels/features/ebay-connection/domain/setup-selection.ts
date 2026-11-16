import type { DomainEvent } from "@chase-sets/event-core";
import type { DomainEventCodec } from "@chase-sets/event-core/codec";
import { EbaySetupError, policyTypes, type PolicyType } from "./setup-material";

export type SetupSelection = Readonly<{
  connectionId: string;
  setupGeneration: number;
  policies: readonly Readonly<{ policyType: PolicyType; policyId: string; materialFingerprint: string }>[];
  locationPairs: readonly Readonly<{
    storageLocationId: string;
    merchantLocationKey: string;
    materialFingerprint: string;
  }>[];
}>;
export type EbaySellerSetupSelectedV1 = DomainEvent<"channels.ebay-seller-setup.selected", SetupSelection>;
export const ebaySellerSetupSelectedCodec: DomainEventCodec<EbaySellerSetupSelectedV1> = {
  encode: (event) => ({ eventType: event.type, payload: parseSetupSelection(event.data) }),
  decode: (stored) => {
    if (stored.eventType !== "channels.ebay-seller-setup.selected") throw new EbaySetupError("invalid-selection");
    return { type: stored.eventType, data: parseSetupSelection(stored.payload) };
  },
};
export type SelectEbaySellerSetup = Readonly<{
  expectedSetupGeneration: number;
  policies: readonly Readonly<{ policyType: PolicyType; policyId: string }>[];
  locationPairs: readonly Readonly<{ storageLocationId: string; merchantLocationKey: string }>[];
}>;
function closed(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw new EbaySetupError("invalid-selection");
}
function id(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.length || value.length > 256 || /[\u0000-\u001f]/u.test(value))
    throw new EbaySetupError("invalid-selection");
}
export function parseSetupCommand(value: unknown): SelectEbaySellerSetup {
  closed(value, ["expectedSetupGeneration", "policies", "locationPairs"]);
  if (
    !Number.isSafeInteger(value.expectedSetupGeneration) ||
    (value.expectedSetupGeneration as number) < 0 ||
    (value.expectedSetupGeneration as number) >= Number.MAX_SAFE_INTEGER ||
    !Array.isArray(value.policies) ||
    value.policies.length !== 3 ||
    !Array.isArray(value.locationPairs) ||
    value.locationPairs.length < 1 ||
    value.locationPairs.length > 200
  )
    throw new EbaySetupError("invalid-selection");
  const policies = value.policies.map((item: unknown) => {
    closed(item, ["policyType", "policyId"]);
    if (!policyTypes.includes(item.policyType as PolicyType)) throw new EbaySetupError("invalid-selection");
    id(item.policyId);
    return { policyType: item.policyType as PolicyType, policyId: item.policyId };
  });
  if (new Set(policies.map((item) => item.policyType)).size !== 3) throw new EbaySetupError("invalid-selection");
  const locationPairs = value.locationPairs.map((item: unknown) => {
    closed(item, ["storageLocationId", "merchantLocationKey"]);
    id(item.storageLocationId);
    id(item.merchantLocationKey);
    return { storageLocationId: item.storageLocationId, merchantLocationKey: item.merchantLocationKey };
  });
  if (
    new Set(locationPairs.map((item) => JSON.stringify([item.storageLocationId, item.merchantLocationKey]))).size !==
    locationPairs.length
  )
    throw new EbaySetupError("invalid-selection");
  return { expectedSetupGeneration: value.expectedSetupGeneration as number, policies, locationPairs };
}
export function parseSetupSelection(value: unknown): SetupSelection {
  closed(value, ["connectionId", "setupGeneration", "policies", "locationPairs"]);
  id(value.connectionId);
  if (
    !Number.isSafeInteger(value.setupGeneration) ||
    (value.setupGeneration as number) < 1 ||
    !Array.isArray(value.policies) ||
    !Array.isArray(value.locationPairs)
  )
    throw new EbaySetupError("invalid-selection");
  const fingerprint = (value: unknown) => {
    if (typeof value !== "string" || !/^v1:[a-f0-9]{64}$/.test(value)) throw new EbaySetupError("invalid-selection");
    return value;
  };
  const policies = value.policies.map((item: unknown) => {
    closed(item, ["policyType", "policyId", "materialFingerprint"]);
    return {
      policyType: item.policyType,
      policyId: item.policyId,
      materialFingerprint: fingerprint(item.materialFingerprint),
    };
  });
  const locationPairs = value.locationPairs.map((item: unknown) => {
    closed(item, ["storageLocationId", "merchantLocationKey", "materialFingerprint"]);
    return {
      storageLocationId: item.storageLocationId,
      merchantLocationKey: item.merchantLocationKey,
      materialFingerprint: fingerprint(item.materialFingerprint),
    };
  });
  const command = parseSetupCommand({
    expectedSetupGeneration: (value.setupGeneration as number) - 1,
    policies: policies.map(({ policyType, policyId }) => ({ policyType, policyId })),
    locationPairs: locationPairs.map(({ storageLocationId, merchantLocationKey }) => ({
      storageLocationId,
      merchantLocationKey,
    })),
  });
  return {
    connectionId: value.connectionId,
    setupGeneration: value.setupGeneration as number,
    policies: command.policies.map((item, index) => ({
      ...item,
      materialFingerprint: policies[index].materialFingerprint,
    })),
    locationPairs: command.locationPairs.map((item, index) => ({
      ...item,
      materialFingerprint: locationPairs[index].materialFingerprint,
    })),
  };
}
