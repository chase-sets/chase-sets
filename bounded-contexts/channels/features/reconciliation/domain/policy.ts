import { definePolicy, type PolicyDefinition } from "@chase-sets/platform-policy/define-policy";
import type { JsonValue } from "@chase-sets/primitives/json";

export type ChannelReconciliationPolicyValue = Readonly<{
  cadenceMs: number;
  saleLookbackMs: number;
  backdatingAttentionAfterMs: number;
  gapPersistenceRuns: number;
  maxListingsPerRun: number;
  maxSaleLinesPerRun: number;
  attentionListingLimit: number;
}>;

export const CHANNEL_RECONCILIATION_POLICY_FALLBACK: ChannelReconciliationPolicyValue = Object.freeze({
  cadenceMs: 900_000,
  saleLookbackMs: 86_400_000,
  backdatingAttentionAfterMs: 21_600_000,
  gapPersistenceRuns: 3,
  maxListingsPerRun: 5_000,
  maxSaleLinesPerRun: 5_000,
  attentionListingLimit: 100,
});

export type ChannelOutboundKillSwitchPolicyValue = Readonly<{
  heldProviderKeys: readonly string[];
  heldConnectionIds: readonly string[];
}>;

export const CHANNEL_OUTBOUND_KILL_SWITCH_FALLBACK: ChannelOutboundKillSwitchPolicyValue = Object.freeze({
  heldProviderKeys: Object.freeze([]),
  heldConnectionIds: Object.freeze([]),
});

export const channelReconciliationPolicy: PolicyDefinition<ChannelReconciliationPolicyValue> = definePolicy({
  policyKey: "channels.reconciliation",
  contextName: "channels",
  schemaSummary:
    "{ cadenceMs, saleLookbackMs, backdatingAttentionAfterMs, gapPersistenceRuns, maxListingsPerRun, maxSaleLinesPerRun, attentionListingLimit: bounded integers }",
  defaultValue: CHANNEL_RECONCILIATION_POLICY_FALLBACK,
  decodeValue: decodeChannelReconciliationPolicy,
});

export const channelOutboundKillSwitchPolicy: PolicyDefinition<ChannelOutboundKillSwitchPolicyValue> = definePolicy({
  policyKey: "channels.outbound-kill-switch",
  contextName: "channels",
  schemaSummary:
    "{ heldProviderKeys: unique sorted opaque strings[], heldConnectionIds: unique sorted opaque strings[] }",
  defaultValue: CHANNEL_OUTBOUND_KILL_SWITCH_FALLBACK,
  decodeValue: decodeChannelOutboundKillSwitchPolicy,
});

export function decodeChannelReconciliationPolicy(raw: JsonValue): ChannelReconciliationPolicyValue {
  const record = closed(raw, [
    "cadenceMs",
    "saleLookbackMs",
    "backdatingAttentionAfterMs",
    "gapPersistenceRuns",
    "maxListingsPerRun",
    "maxSaleLinesPerRun",
    "attentionListingLimit",
  ]);
  return Object.freeze({
    cadenceMs: integer(record.cadenceMs, 60_000, 86_400_000, "cadenceMs"),
    saleLookbackMs: integer(record.saleLookbackMs, 3_600_000, 7_776_000_000, "saleLookbackMs"),
    backdatingAttentionAfterMs: integer(
      record.backdatingAttentionAfterMs,
      0,
      7_776_000_000,
      "backdatingAttentionAfterMs",
    ),
    gapPersistenceRuns: integer(record.gapPersistenceRuns, 1, 100, "gapPersistenceRuns"),
    maxListingsPerRun: integer(record.maxListingsPerRun, 1, 100_000, "maxListingsPerRun"),
    maxSaleLinesPerRun: integer(record.maxSaleLinesPerRun, 1, 100_000, "maxSaleLinesPerRun"),
    attentionListingLimit: integer(record.attentionListingLimit, 1, 1_000, "attentionListingLimit"),
  });
}

export function decodeChannelOutboundKillSwitchPolicy(raw: JsonValue): ChannelOutboundKillSwitchPolicyValue {
  const record = closed(raw, ["heldProviderKeys", "heldConnectionIds"]);
  return Object.freeze({
    heldProviderKeys: boundedSortedStrings(record.heldProviderKeys, "heldProviderKeys"),
    heldConnectionIds: boundedSortedStrings(record.heldConnectionIds, "heldConnectionIds"),
  });
}

function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid("value must be an object.");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some((key) => !Object.hasOwn(record, key))) {
    invalid(`value must contain exactly ${keys.join(", ")}.`);
  }
  return record;
}

function integer(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    invalid(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return Number(value);
}

function boundedSortedStrings(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 1_000) invalid(`${label} must contain at most 1000 entries.`);
  const strings = value.map((entry) => {
    if (typeof entry !== "string" || entry.length < 1 || entry.length > 128) invalid(`${label} entry is invalid.`);
    return entry;
  });
  if (
    new Set(strings).size !== strings.length ||
    strings.some((entry, index) => index > 0 && strings[index - 1]! >= entry)
  ) {
    invalid(`${label} must be unique and ascending.`);
  }
  return Object.freeze(strings);
}

function invalid(message: string): never {
  throw new Error(`Invalid Channels reconciliation policy: ${message}`);
}
