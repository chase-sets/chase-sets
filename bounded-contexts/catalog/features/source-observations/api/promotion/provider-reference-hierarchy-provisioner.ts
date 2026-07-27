import type { JsonValue } from "@chase-sets/primitives/json";
import type { ReferenceRecordId, ReferenceTypeId } from "../../../../ids";
import type { ReferenceRelationship } from "../../../reference-data/domain/domain";
import type {
  CatalogProviderIntegrationProfile,
  CatalogProviderReferenceHierarchyAttributeRule,
  CatalogProviderReferenceHierarchyRecordRule,
  CatalogProviderReferenceHierarchyValueRule,
} from "../provider-integration-profiles";

export type CatalogProviderReferenceHierarchyProvisioner = Readonly<{
  ensureReferenceType: (def: CatalogProviderReferenceTypeProvision) => Promise<void>;
  ensureReferenceRecord: (def: CatalogProviderReferenceRecordProvision) => Promise<ReferenceRecordId>;
}>;

export type CatalogProviderReferenceTypeProvision = Readonly<{
  referenceTypeId: ReferenceTypeId;
  key: string;
  name: string;
  description: string;
  attributeKeys: readonly string[];
}>;

export type CatalogProviderReferenceRecordProvision = Readonly<{
  referenceRecordId: ReferenceRecordId;
  typeKey: string;
  key: string;
  name: string;
  description: string;
  attributes?: Readonly<Record<string, JsonValue>>;
  relationships?: readonly ReferenceRelationship[];
}>;

export type CatalogProviderReferenceHierarchyProvisioningResult = Readonly<{
  targetReferenceRecordId: ReferenceRecordId;
  referenceRecordIdsByRuleKey: ReadonlyMap<string, ReferenceRecordId>;
}>;

export async function provisionCatalogProviderReferenceHierarchy(input: {
  profile: CatalogProviderIntegrationProfile;
  payload: JsonValue;
  provisioner: CatalogProviderReferenceHierarchyProvisioner;
}): Promise<CatalogProviderReferenceHierarchyProvisioningResult> {
  for (const referenceType of input.profile.referenceHierarchyMapping.referenceTypes) {
    await input.provisioner.ensureReferenceType({
      referenceTypeId: referenceType.referenceTypeId as ReferenceTypeId,
      key: referenceType.typeKey,
      name: referenceType.name,
      description: referenceType.descriptionText,
      attributeKeys: referenceType.attributeKeys,
    });
  }

  const referenceRecordIdsByRuleKey = new Map<string, ReferenceRecordId>();
  for (const recordRule of input.profile.referenceHierarchyMapping.referenceRecords) {
    if (!requiredPathsPresent(input.payload, recordRule.requiredPaths ?? [])) {
      continue;
    }

    const provision = referenceRecordProvision(input.profile, input.payload, recordRule, referenceRecordIdsByRuleKey);
    if (!provision) {
      continue;
    }

    const referenceRecordId = await input.provisioner.ensureReferenceRecord(provision);
    referenceRecordIdsByRuleKey.set(recordRule.ruleKey, referenceRecordId);
  }

  const targetReferenceRecordId = referenceRecordIdsByRuleKey.get(
    input.profile.referenceHierarchyMapping.targetRecordRuleKey,
  );
  if (!targetReferenceRecordId) {
    throw new Error(
      `${input.profile.displayName} reference hierarchy did not resolve target record '${input.profile.referenceHierarchyMapping.targetRecordRuleKey}'.`,
    );
  }

  return {
    targetReferenceRecordId,
    referenceRecordIdsByRuleKey,
  };
}

function referenceRecordProvision(
  profile: CatalogProviderIntegrationProfile,
  payload: JsonValue,
  recordRule: CatalogProviderReferenceHierarchyRecordRule,
  referenceRecordIdsByRuleKey: ReadonlyMap<string, ReferenceRecordId>,
): CatalogProviderReferenceRecordProvision | null {
  const referenceRecordId = referenceRecordIdForRule(profile, payload, recordRule);
  const key = valueAsString(recordRule.key, payload);
  const name = valueAsString(recordRule.name, payload);
  const description = valueAsString(recordRule.description, payload);

  if (!referenceRecordId || !key || !name || !description) {
    return null;
  }

  return {
    referenceRecordId,
    typeKey: recordRule.typeKey,
    key: normalizeReferenceKey(key),
    name,
    description,
    attributes: attributesForRule(recordRule.attributes ?? [], payload),
    relationships: relationshipsForRule(recordRule.relationships ?? [], referenceRecordIdsByRuleKey),
  };
}

function referenceRecordIdForRule(
  profile: CatalogProviderIntegrationProfile,
  payload: JsonValue,
  recordRule: CatalogProviderReferenceHierarchyRecordRule,
): ReferenceRecordId | null {
  if (recordRule.recordId.kind === "static") {
    return recordRule.recordId.referenceRecordId as ReferenceRecordId;
  }

  const providerId = firstStringValue(recordRule.recordId.providerValuePaths.map((path) => valueAtPath(payload, path)));
  if (!providerId) {
    return null;
  }

  return `${profile.referenceHierarchyMapping.providerReferenceIdPrefix}_${recordRule.recordId.typeKey}_${normalizeReferenceKey(providerId).replace(/-/g, "_")}` as ReferenceRecordId;
}

function attributesForRule(
  attributeRules: readonly CatalogProviderReferenceHierarchyAttributeRule[],
  payload: JsonValue,
): Readonly<Record<string, JsonValue>> {
  const attributes: Record<string, JsonValue> = {};
  for (const attributeRule of attributeRules) {
    const value = valueForRule(attributeRule.value, payload);
    if (isMissingAttributeValue(value)) {
      if (attributeRule.optional) {
        continue;
      }
      continue;
    }
    attributes[attributeRule.attributeKey] = value;
  }
  return attributes;
}

function relationshipsForRule(
  relationshipRules: NonNullable<CatalogProviderReferenceHierarchyRecordRule["relationships"]>,
  referenceRecordIdsByRuleKey: ReadonlyMap<string, ReferenceRecordId>,
): readonly ReferenceRelationship[] {
  return relationshipRules.flatMap((relationshipRule) => {
    const referenceId =
      referenceRecordIdsByRuleKey.get(relationshipRule.ruleKey) ??
      (relationshipRule.fallbackRuleKey
        ? referenceRecordIdsByRuleKey.get(relationshipRule.fallbackRuleKey)
        : undefined);
    return referenceId ? [{ relationshipType: relationshipRule.relationshipType, referenceId }] : [];
  });
}

function requiredPathsPresent(payload: JsonValue, paths: readonly string[]): boolean {
  return paths.every((path) => !isMissingAttributeValue(valueAtPath(payload, path)));
}

function valueAsString(rule: CatalogProviderReferenceHierarchyValueRule, payload: JsonValue): string | null {
  const value = valueForRule(rule, payload);
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const normalized = String(value).trim();
    return normalized ? normalized : null;
  }
  return null;
}

function valueForRule(rule: CatalogProviderReferenceHierarchyValueRule, payload: JsonValue): JsonValue | undefined {
  if (rule.kind === "static") {
    return rule.value;
  }

  if (rule.kind === "path") {
    return valueAtPath(payload, rule.path);
  }

  return Object.entries(rule.values).reduce(
    (text, [key, valueRule]) => text.replaceAll(`{${key}}`, valueAsString(valueRule, payload) ?? ""),
    rule.template,
  );
}

function valueAtPath(value: JsonValue, path: string): JsonValue | undefined {
  const segments = path.split(".").filter(Boolean);
  let current: JsonValue | undefined = value;

  for (const segment of segments) {
    if (!isJsonRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }

  return current;
}

function firstStringValue(values: readonly (JsonValue | undefined)[]): string | null {
  for (const value of values) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      const normalized = String(value).trim();
      if (normalized) {
        return normalized;
      }
    }
  }
  return null;
}

function isMissingAttributeValue(value: JsonValue | undefined): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim().length === 0);
}

function isJsonRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeReferenceKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}
