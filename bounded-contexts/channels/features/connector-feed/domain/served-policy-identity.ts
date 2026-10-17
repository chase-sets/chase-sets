import { createHash } from "node:crypto";
import { encodePolicyValue } from "@chase-sets/platform-policy/define-policy";
import type { ResolvedPolicy } from "@chase-sets/platform-policy/resolver";
import { canonicalJson } from "../../outbound-sync/domain/validation";
import { assertClosedRecord, assertOpaqueId, assertRfc3339Instant } from "../../connections/domain/validation";
import { connectorTransportPolicy, decodeConnectorPolicy, type ConnectorPolicy } from "./policy";

export function decodeServedConnectorPolicy(input: ResolvedPolicy<ConnectorPolicy>): ResolvedPolicy<ConnectorPolicy> {
  assertClosedRecord(
    input,
    ["policyKey", "source", "documentId", "effectiveFrom", "effectiveUntil", "resolvedAt", "value"],
    "served policy",
  );
  if (input.policyKey !== connectorTransportPolicy.policyKey) throw new Error("invalid-connector-policy-key");
  assertRfc3339Instant(input.resolvedAt);
  if (input.source === "fallback") {
    if (input.documentId !== null || input.effectiveFrom !== null || input.effectiveUntil !== null)
      throw new Error("invalid-connector-policy-fallback");
  } else if (input.source === "policy") {
    assertOpaqueId(input.documentId, "documentId");
    assertRfc3339Instant(input.effectiveFrom);
    if (input.effectiveUntil !== null) {
      assertRfc3339Instant(input.effectiveUntil);
      if (Date.parse(input.effectiveUntil) <= Date.parse(input.effectiveFrom)) throw new Error("invalid-policy-window");
    }
  } else throw new Error("invalid-connector-policy-source");
  return { ...input, value: decodeConnectorPolicy(input.value) };
}

export function deriveServedPolicyIdentity(input: ResolvedPolicy<ConnectorPolicy>): string {
  const { policyKey, source, documentId, effectiveFrom, effectiveUntil, value } = decodeServedConnectorPolicy(input);
  return createHash("sha256")
    .update(
      canonicalJson({ policyKey, source, documentId, effectiveFrom, effectiveUntil, value: encodePolicyValue(value) }),
    )
    .digest("hex");
}
