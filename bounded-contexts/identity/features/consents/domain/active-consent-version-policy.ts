import { definePolicy, type PolicyDefinition } from "@chase-sets/platform-policy/define-policy";
import type { JsonValue } from "@chase-sets/primitives/json";
import {
  publicPolicyKeys,
  publicPolicyPublicationRecords,
  type PublicPolicyKey,
  type PublicPolicyVersion,
} from "@chase-sets/public-docs";
import { IdentityDomainError } from "../../../support/runtime-support/common";

export const CONSENT_POLICY_VERSION_PATTERN = /^v[1-9][0-9]*$/;

export type ActiveConsentVersionPolicyValue = Readonly<{
  version: PublicPolicyVersion;
}>;

export function decodeActiveConsentVersionPolicyValue(raw: JsonValue): ActiveConsentVersionPolicyValue {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new IdentityDomainError("Active consent version policy value must be an object.");
  }

  const record = raw as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || !Object.prototype.hasOwnProperty.call(record, "version")) {
    throw new IdentityDomainError("Active consent version policy value must contain only version.");
  }
  const version = typeof record.version === "string" ? record.version.trim() : "";
  if (!CONSENT_POLICY_VERSION_PATTERN.test(version)) {
    throw new IdentityDomainError(
      `Active consent version policy version must match ${CONSENT_POLICY_VERSION_PATTERN}.`,
    );
  }

  return { version: version as PublicPolicyVersion };
}

function activeVersionPolicyKey(policyKey: PublicPolicyKey) {
  return `identity.${policyKey}-active-version`;
}

function defineActiveConsentVersionPolicy(
  policyKey: PublicPolicyKey,
): PolicyDefinition<ActiveConsentVersionPolicyValue> {
  return definePolicy({
    policyKey: activeVersionPolicyKey(policyKey),
    contextName: "identity",
    schemaSummary: "{ version: string matching /^v[1-9][0-9]*$/ }",
    defaultValue: { version: publicPolicyPublicationRecords[policyKey].version },
    decodeValue: decodeActiveConsentVersionPolicyValue,
  });
}

export const identityActiveConsentVersionPolicies = Object.fromEntries(
  publicPolicyKeys.map((policyKey) => [policyKey, defineActiveConsentVersionPolicy(policyKey)]),
) as Readonly<Record<PublicPolicyKey, PolicyDefinition<ActiveConsentVersionPolicyValue>>>;
