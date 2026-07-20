import { definePolicy, type PolicyDefinition } from "@chase-sets/platform-policy/define-policy";
import type { JsonValue } from "@chase-sets/primitives/json";
import { SettlementDomainError } from "../../../support/runtime-support/common";

export type AccountLinkageFlagPolicyValue = Readonly<{
  minimumClusterSize: number;
  sharedInstrumentEnabled: boolean;
  sharedAddressEnabled: boolean;
}>;

export const ACCOUNT_LINKAGE_FLAG_LAUNCH_POLICY_VALUE: AccountLinkageFlagPolicyValue = {
  minimumClusterSize: 2,
  sharedInstrumentEnabled: true,
  sharedAddressEnabled: true,
};

const MIN_CLUSTER_SIZE = 2;
const MAX_CLUSTER_SIZE = 1_000;

export function decodeAccountLinkageFlagPolicyValue(raw: JsonValue): AccountLinkageFlagPolicyValue {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new SettlementDomainError("Account-linkage flag policy value must be an object.");
  }
  const record = raw as Record<string, unknown>;
  const minimumClusterSize = Number(record.minimumClusterSize);
  if (
    !Number.isInteger(minimumClusterSize) ||
    minimumClusterSize < MIN_CLUSTER_SIZE ||
    minimumClusterSize > MAX_CLUSTER_SIZE
  ) {
    throw new SettlementDomainError(
      `Account-linkage minimum cluster size must be between ${MIN_CLUSTER_SIZE} and ${MAX_CLUSTER_SIZE}.`,
    );
  }
  if (typeof record.sharedInstrumentEnabled !== "boolean" || typeof record.sharedAddressEnabled !== "boolean") {
    throw new SettlementDomainError("Account-linkage per-signal enablement values must be booleans.");
  }
  return {
    minimumClusterSize,
    sharedInstrumentEnabled: record.sharedInstrumentEnabled,
    sharedAddressEnabled: record.sharedAddressEnabled,
  };
}

export const accountLinkageFlagPolicy: PolicyDefinition<AccountLinkageFlagPolicyValue> = definePolicy({
  policyKey: "settlement.account-linkage-flags",
  contextName: "settlement",
  schemaSummary:
    "{ minimumClusterSize: integer 2-1000, sharedInstrumentEnabled: boolean, sharedAddressEnabled: boolean }",
  defaultValue: ACCOUNT_LINKAGE_FLAG_LAUNCH_POLICY_VALUE,
  decodeValue: decodeAccountLinkageFlagPolicyValue,
});
