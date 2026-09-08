import { createHash } from "node:crypto";
import type { GradedCardSnapshot } from "@chase-sets/primitives/graded-card-snapshot";
import type {
  ChannelCompositionProfile,
  ChannelCompositionProfileRegistry,
  ChannelMappingResolution,
} from "./contracts";

export function compareUnicodeScalars(left: string, right: string): number {
  const leftScalars = Array.from(left, (value) => value.codePointAt(0)!);
  const rightScalars = Array.from(right, (value) => value.codePointAt(0)!);
  for (let index = 0; index < Math.min(leftScalars.length, rightScalars.length); index += 1) {
    const difference = leftScalars[index]! - rightScalars[index]!;
    if (difference !== 0) return difference;
  }
  return leftScalars.length - rightScalars.length;
}

export function deriveChannelSelectedOptionKey(
  selectedOptions: readonly Readonly<{ dimensionId: string; optionId: string }>[],
): string {
  return selectedOptions
    .map(({ dimensionId, optionId }) => ({ dimensionId: dimensionId.trim(), optionId: optionId.trim() }))
    .filter(({ dimensionId, optionId }) => dimensionId.length > 0 && optionId.length > 0)
    .sort(
      (left, right) =>
        compareUnicodeScalars(left.dimensionId, right.dimensionId) ||
        compareUnicodeScalars(left.optionId, right.optionId),
    )
    .map(({ dimensionId, optionId }) => `${dimensionId}:${optionId}`)
    .join("|");
}

export type ChannelListingIdDigest = (framedPair: string) => string;

export function deriveChannelListingId(
  connectionId: string,
  listingId: string,
  digest: ChannelListingIdDigest = (value) => createHash("sha256").update(value, "utf8").digest("hex"),
): string {
  const framedPair = `${Array.from(connectionId).length}:${connectionId}:${listingId}`;
  return `cl_${digest(framedPair).toLowerCase()}`;
}

export function buildChannelCategorySourceKeys(categoryIds: readonly string[]): readonly string[] {
  return [...categoryIds].sort(compareUnicodeScalars).map((categoryId) => `catalog-category:${categoryId}`);
}

export function buildChannelConditionSourceKeys(
  selectedOptions: readonly Readonly<{ dimensionId: string; optionId: string }>[],
  gradedCard: GradedCardSnapshot | null,
  conditionDimensionId: string | null,
): readonly string[] {
  const keys: string[] = [];
  if (conditionDimensionId !== null) {
    const selected = selectedOptions.filter((entry) => entry.dimensionId === conditionDimensionId);
    keys.push(...selected.map((entry) => `selected-option:${entry.dimensionId}:${entry.optionId}`));
  }
  if (gradedCard) keys.push(`graded-condition:${gradedCard.gradingCompany}|${gradedCard.grade}`);
  return keys;
}

export function buildChannelGradedAttributeSourceEntries(
  gradedCard: GradedCardSnapshot | null,
): readonly Readonly<{ sourceKey: string; value: string }>[] {
  if (!gradedCard) return [];
  const entries: Array<Readonly<{ sourceKey: string; value: string }>> = [
    { sourceKey: "graded:grading-company", value: gradedCard.gradingCompany },
    { sourceKey: "graded:grade", value: gradedCard.grade },
  ];
  if (gradedCard.certificationNumber !== null) {
    entries.push({ sourceKey: "graded:certification-number", value: gradedCard.certificationNumber });
  }
  if (gradedCard.population !== null) {
    if (gradedCard.population.populationAtGrade !== null) {
      entries.push({ sourceKey: "graded:population-at-grade", value: String(gradedCard.population.populationAtGrade) });
    }
    if (gradedCard.population.populationHigher !== null) {
      entries.push({ sourceKey: "graded:population-higher", value: String(gradedCard.population.populationHigher) });
    }
    if (gradedCard.population.source !== null) {
      entries.push({ sourceKey: "graded:population-source", value: gradedCard.population.source });
    }
    if (gradedCard.population.asOf !== null) {
      entries.push({ sourceKey: "graded:population-as-of", value: gradedCard.population.asOf });
    }
  }
  gradedCard.conditionDescriptors.forEach((value, index) => {
    entries.push({ sourceKey: `graded:condition-descriptor:${index}`, value });
  });
  return entries;
}

export function findAcceptedChannelMapping(
  mappings: readonly ChannelMappingResolution[],
  dimension: ChannelMappingResolution["dimension"],
  sourceKey: string,
): ChannelMappingResolution | null {
  const mapping = mappings.find((candidate) => candidate.dimension === dimension && candidate.sourceKey === sourceKey);
  if (!mapping) return null;
  switch (mapping.reviewStatus) {
    case "accepted":
    case "auto-accepted":
      return mapping.targetKey === null ? null : mapping;
    case "proposed":
    case "rejected":
    case "revoked":
      return null;
    default:
      return null;
  }
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort(compareUnicodeScalars)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function hashChannelDesiredState(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function createChannelCompositionProfileRegistry(
  profiles: readonly ChannelCompositionProfile[] = [],
): ChannelCompositionProfileRegistry {
  const byIdentity = new Map<string, ChannelCompositionProfile>();
  for (const profile of profiles) {
    assertChannelCompositionProfile(profile);
    const key = `${profile.identity.providerKey}\u0000${profile.identity.environment}`;
    if (byIdentity.has(key)) throw new Error("Channel Composition Profile identity must be unique.");
    byIdentity.set(key, structuredClone(profile));
  }
  return Object.freeze({
    get: (identity: Readonly<{ providerKey: string; environment: "sandbox" | "production" }>) =>
      byIdentity.get(`${identity.providerKey}\u0000${identity.environment}`) ?? null,
    list: () =>
      [...byIdentity.values()]
        .map(({ identity }) => identity)
        .sort(
          (left, right) =>
            compareUnicodeScalars(left.providerKey, right.providerKey) ||
            compareUnicodeScalars(left.environment, right.environment),
        ),
  });
}

export const channelCompositionProfileRegistry = createChannelCompositionProfileRegistry();

export function assertChannelCompositionProfile(value: unknown): asserts value is ChannelCompositionProfile {
  profileRecord(value, [
    "identity",
    "derivation",
    "snapshotPreservedPlaceholder",
    "requiresProviderProductReference",
    "requiresProviderCatalogItemReference",
    "conditionDimensionId",
    "title",
    "description",
    "category",
    "condition",
    "attributes",
    "quantity",
    "price",
    "forbiddenPatterns",
  ]);
  const profile = value as ChannelCompositionProfile;
  profileRecord(profile.identity, ["providerKey", "environment"]);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(profile.identity.providerKey))
    throw new Error("Channel Composition Profile providerKey is invalid.");
  if (profile.identity.environment !== "sandbox" && profile.identity.environment !== "production")
    throw new Error("Channel Composition Profile environment is invalid.");
  profileRecord(profile.derivation, ["sourceKind", "sourceRef", "sourceVersion", "capturedAt"]);
  if (
    !profile.derivation ||
    Object.values(profile.derivation).some((member) => typeof member !== "string" || !member)
  ) {
    throw new Error("Channel Composition Profile derivation is required.");
  }
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(profile.derivation.capturedAt) ||
    Number.isNaN(Date.parse(profile.derivation.capturedAt))
  )
    throw new Error("Channel Composition Profile capturedAt must be an RFC 3339 instant.");
  if (!/^chase-sets:snapshot-preserved:[a-z0-9-]{1,200}$/.test(profile.snapshotPreservedPlaceholder)) {
    throw new Error("Channel Composition Profile placeholder is invalid.");
  }
  if (
    typeof profile.requiresProviderProductReference !== "boolean" ||
    typeof profile.requiresProviderCatalogItemReference !== "boolean"
  )
    throw new Error("Channel Composition Profile reference requirements are invalid.");
  if (profile.conditionDimensionId !== null && typeof profile.conditionDimensionId !== "string")
    throw new Error("Channel Composition Profile conditionDimensionId is invalid.");
  for (const dimension of [profile.title, profile.description]) {
    profileRecord(dimension, ["mode", "maxLength", "snapshotField"]);
    if (dimension.mode !== "template" && dimension.mode !== "snapshot-preserved")
      throw new Error("Channel Composition Profile text mode is invalid.");
    if (typeof dimension.snapshotField !== "string" || dimension.snapshotField.length === 0)
      throw new Error("Channel Composition Profile snapshotField is required.");
  }
  for (const dimension of [profile.category, profile.condition]) {
    profileRecord(dimension, ["mode", "maxKeyLength", "snapshotField"]);
    if (dimension.mode !== "mapped" && dimension.mode !== "snapshot-preserved")
      throw new Error("Channel Composition Profile key mode is invalid.");
    if (typeof dimension.snapshotField !== "string" || dimension.snapshotField.length === 0)
      throw new Error("Channel Composition Profile snapshotField is required.");
  }
  profileRecord(profile.attributes, ["mode", "maxCount", "maxKeyLength", "maxValueLength", "snapshotField"]);
  if (profile.attributes.mode !== "mapped" && profile.attributes.mode !== "snapshot-preserved")
    throw new Error("Channel Composition Profile attribute mode is invalid.");
  if (typeof profile.attributes.snapshotField !== "string" || profile.attributes.snapshotField.length === 0)
    throw new Error("Channel Composition Profile snapshotField is required.");
  profileRecord(profile.quantity, ["max", "draftField"]);
  profileRecord(profile.price, ["maxAmountMinor", "allowedCurrencies", "draftField"]);
  if (profile.condition.mode === "mapped" && profile.conditionDimensionId === null) {
    throw new Error("Mapped condition requires conditionDimensionId.");
  }
  const positiveIntegers = [
    profile.title.maxLength,
    profile.description.maxLength,
    profile.category.maxKeyLength,
    profile.condition.maxKeyLength,
    profile.attributes.maxCount,
    profile.attributes.maxKeyLength,
    profile.attributes.maxValueLength,
    profile.quantity.max,
    profile.price.maxAmountMinor,
  ];
  if (positiveIntegers.some((member) => !Number.isSafeInteger(member) || member < 1)) {
    throw new Error("Channel Composition Profile bounds must be positive safe integers.");
  }
  if (
    !Array.isArray(profile.price.allowedCurrencies) ||
    profile.price.allowedCurrencies.length === 0 ||
    profile.price.allowedCurrencies.some((code) => !/^[A-Z]{3}$/.test(code)) ||
    new Set(profile.price.allowedCurrencies).size !== profile.price.allowedCurrencies.length
  ) {
    throw new Error("Channel Composition Profile allowedCurrencies is invalid.");
  }
  if (!Array.isArray(profile.forbiddenPatterns) || profile.forbiddenPatterns.length > 100)
    throw new Error("Channel Composition Profile forbiddenPatterns is invalid.");
  for (const pattern of profile.forbiddenPatterns) new RegExp(pattern, "u");
}

function profileRecord(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Channel Composition Profile member must be a record.");
  const actual = Object.keys(value);
  if (actual.some((key) => !keys.includes(key)) || keys.some((key) => !actual.includes(key)))
    throw new Error("Channel Composition Profile member is not recursively closed.");
}
