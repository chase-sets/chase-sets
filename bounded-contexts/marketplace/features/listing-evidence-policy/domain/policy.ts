import { createHash } from "node:crypto";
import { catalogSeedIds } from "@chase-sets/catalog-seed";
import { definePolicy, type PolicyDefinition } from "@chase-sets/platform-policy/define-policy";
import type { JsonValue } from "@chase-sets/primitives/json";
import { centsToMoneyAmount, tryMoneyToCents } from "@chase-sets/primitives/money";

export const LISTING_EVIDENCE_POLICY_KEY = "marketplace.listing-evidence";
export const LISTING_EVIDENCE_POLICY_SCHEMA_VERSION = 1;

export type ListingEvidencePolicyLifecycle = "draft" | "validated" | "active" | "superseded" | "rejected";
export type BuyerAcknowledgmentPosture = "none" | "required";

export type ListingEvidenceSelector = Readonly<{
  catalogItemIds: readonly string[];
  productIds: readonly string[];
  blueprintIds: readonly string[];
  categoryIds: readonly string[];
  options: readonly Readonly<{ dimensionId: string; optionId: string }>[];
  gradedItem: boolean | null;
  priceBand: Readonly<{ minimumAmount: string | null; maximumAmount: string | null }> | null;
  seller: Readonly<{
    minimumReviewCount: number | null;
    badgeKeys: readonly string[];
    riskLevels: readonly string[];
  }>;
}>;

export type ListingEvidenceSlotRequirement = Readonly<{
  slotId: string;
  viewKind: string;
  minimumWidthPixels: number | null;
  minimumHeightPixels: number | null;
  maximumAgeHours: number | null;
}>;

export type ListingEvidenceRuleOutcome = Readonly<{
  minimumPhotoCount: number;
  requiredSlots: readonly ListingEvidenceSlotRequirement[];
  sellerTrust: Readonly<{
    satisfaction: "any";
    minimumReviewCount: number;
    acceptedBadgeKeys: readonly string[];
  }> | null;
  buyerAcknowledgment: BuyerAcknowledgmentPosture;
}>;

export type ListingEvidencePolicyRule = Readonly<{
  ruleId: string;
  explanationCode: string;
  priority: number;
  selector: ListingEvidenceSelector;
  outcome: ListingEvidenceRuleOutcome;
}>;

export type ListingEvidencePolicyValue = Readonly<{
  schemaVersion: 1;
  policyName: string;
  lifecycle: ListingEvidencePolicyLifecycle;
  sourcePolicyDocumentId: string | null;
  validation: Readonly<{
    validatedAt: string;
    policyHash: string;
    impactPreviewHash: string;
  }> | null;
  rules: readonly ListingEvidencePolicyRule[];
}>;

export type ListingEvidencePolicyDiagnostic = Readonly<{
  code: string;
  path: string;
  message: string;
}>;

export type ListingEvidenceEvaluationFacts = Readonly<{
  catalogItemId: string;
  productId: string;
  blueprintId: string | null;
  categoryIds: readonly string[];
  selectedOptions: readonly Readonly<{ dimensionId: string; optionId: string }>[];
  gradedItem: boolean;
  priceAmount: string;
  seller: Readonly<{ reviewCount: number; badgeKeys: readonly string[]; riskLevel: string | null }>;
}>;

export type ResolvedListingEvidenceRequirements = Readonly<{
  minimumPhotoCount: number;
  requiredSlots: readonly ListingEvidenceSlotRequirement[];
  sellerTrustRequirements: readonly Readonly<{
    ruleId: string;
    satisfaction: "any";
    minimumReviewCount: number;
    acceptedBadgeKeys: readonly string[];
  }>[];
  buyerAcknowledgment: BuyerAcknowledgmentPosture;
}>;

export type ListingEvidencePolicyEvaluation = Readonly<{
  policyId: string | null;
  policyVersion: number | null;
  policyHash: string;
  matchedRuleIds: readonly string[];
  requirements: ResolvedListingEvidenceRequirements;
  effectiveInterval: Readonly<{ from: string | null; until: string | null }>;
  explanationCodes: readonly string[];
}>;

export class ListingEvidencePolicyError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ListingEvidencePolicyError";
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ListingEvidencePolicyError(message);
}

function recordOf(value: unknown, name: string): Record<string, unknown> {
  assert(typeof value === "object" && value !== null && !Array.isArray(value), `${name} must be an object.`);
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string, pattern?: RegExp): string {
  const normalized = String(value ?? "").trim();
  assert(normalized.length > 0, `${name} is required.`);
  assert(!pattern || pattern.test(normalized), `${name} has an invalid format.`);
  return normalized;
}

function nullableText(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return normalized.length > 0 ? normalized : null;
}

function stringList(value: unknown, name: string): readonly string[] {
  assert(Array.isArray(value), `${name} must be a list.`);
  return [...new Set(value.map((entry) => text(entry, `${name} entry`)))].sort();
}

function wholeNumber(value: unknown, name: string, min: number, max: number): number {
  const number = Number(value);
  assert(
    Number.isInteger(number) && number >= min && number <= max,
    `${name} must be a whole number from ${min} to ${max}.`,
  );
  return number;
}

function nullableWholeNumber(value: unknown, name: string, min: number, max: number): number | null {
  return value === null || value === undefined || value === "" ? null : wholeNumber(value, name, min, max);
}

function nullableMoney(value: unknown, name: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  const cents = tryMoneyToCents(String(value).trim());
  assert(cents !== null && cents >= 0n, `${name} must be a non-negative decimal amount.`);
  return centsToMoneyAmount(cents);
}

function decodeSelector(value: unknown, path: string): ListingEvidenceSelector {
  const record = recordOf(value, path);
  const options = Array.isArray(record.options)
    ? record.options.map((entry, index) => {
        const option = recordOf(entry, `${path}.options[${index}]`);
        return {
          dimensionId: text(option.dimensionId, `${path}.options[${index}].dimensionId`),
          optionId: text(option.optionId, `${path}.options[${index}].optionId`),
        };
      })
    : [];
  const priceBandRecord =
    record.priceBand === null || record.priceBand === undefined
      ? null
      : recordOf(record.priceBand, `${path}.priceBand`);
  const priceBand = priceBandRecord
    ? {
        minimumAmount: nullableMoney(priceBandRecord.minimumAmount, `${path}.priceBand.minimumAmount`),
        maximumAmount: nullableMoney(priceBandRecord.maximumAmount, `${path}.priceBand.maximumAmount`),
      }
    : null;
  if (priceBand?.minimumAmount && priceBand.maximumAmount) {
    assert(
      tryMoneyToCents(priceBand.minimumAmount)! < tryMoneyToCents(priceBand.maximumAmount)!,
      `${path}.priceBand maximum must be greater than its minimum.`,
    );
  }
  const seller = recordOf(record.seller ?? {}, `${path}.seller`);
  return {
    catalogItemIds: stringList(record.catalogItemIds ?? [], `${path}.catalogItemIds`),
    productIds: stringList(record.productIds ?? [], `${path}.productIds`),
    blueprintIds: stringList(record.blueprintIds ?? [], `${path}.blueprintIds`),
    categoryIds: stringList(record.categoryIds ?? [], `${path}.categoryIds`),
    options: [...options].sort((left, right) =>
      `${left.dimensionId}:${left.optionId}`.localeCompare(`${right.dimensionId}:${right.optionId}`),
    ),
    gradedItem: typeof record.gradedItem === "boolean" ? record.gradedItem : null,
    priceBand,
    seller: {
      minimumReviewCount: nullableWholeNumber(
        seller.minimumReviewCount,
        `${path}.seller.minimumReviewCount`,
        0,
        1_000_000,
      ),
      badgeKeys: stringList(seller.badgeKeys ?? [], `${path}.seller.badgeKeys`),
      riskLevels: stringList(seller.riskLevels ?? [], `${path}.seller.riskLevels`),
    },
  };
}

function decodeSlot(value: unknown, path: string): ListingEvidenceSlotRequirement {
  const record = recordOf(value, path);
  return {
    slotId: text(record.slotId, `${path}.slotId`, /^[a-z][a-z0-9-]{1,63}$/),
    viewKind: text(record.viewKind, `${path}.viewKind`, /^[a-z][a-z0-9-]{1,63}$/),
    minimumWidthPixels: nullableWholeNumber(record.minimumWidthPixels, `${path}.minimumWidthPixels`, 1, 100_000),
    minimumHeightPixels: nullableWholeNumber(record.minimumHeightPixels, `${path}.minimumHeightPixels`, 1, 100_000),
    maximumAgeHours: nullableWholeNumber(record.maximumAgeHours, `${path}.maximumAgeHours`, 1, 87_600),
  };
}

function decodeRule(value: unknown, index: number): ListingEvidencePolicyRule {
  const path = `rules[${index}]`;
  const record = recordOf(value, path);
  const outcome = recordOf(record.outcome, `${path}.outcome`);
  const sellerTrust =
    outcome.sellerTrust === null || outcome.sellerTrust === undefined
      ? null
      : recordOf(outcome.sellerTrust, `${path}.outcome.sellerTrust`);
  if (sellerTrust) {
    assert(
      sellerTrust.satisfaction === undefined || sellerTrust.satisfaction === "any",
      `${path}.outcome.sellerTrust.satisfaction must be 'any'.`,
    );
  }
  const sellerTrustMinimumReviewCount = sellerTrust
    ? wholeNumber(sellerTrust.minimumReviewCount ?? 0, `${path}.outcome.sellerTrust.minimumReviewCount`, 0, 1_000_000)
    : 0;
  const acceptedBadgeKeys = sellerTrust
    ? stringList(sellerTrust.acceptedBadgeKeys ?? [], `${path}.outcome.sellerTrust.acceptedBadgeKeys`)
    : [];
  assert(
    !sellerTrust || sellerTrustMinimumReviewCount > 0 || acceptedBadgeKeys.length > 0,
    `${path}.outcome.sellerTrust needs a positive review threshold or an accepted badge.`,
  );
  return {
    ruleId: text(record.ruleId, `${path}.ruleId`, /^[a-z][a-z0-9-]{2,79}$/),
    explanationCode: text(record.explanationCode, `${path}.explanationCode`, /^[a-z][a-z0-9.-]{2,99}$/),
    priority: wholeNumber(record.priority ?? index * 10, `${path}.priority`, 0, 1_000_000),
    selector: decodeSelector(record.selector ?? {}, `${path}.selector`),
    outcome: {
      minimumPhotoCount: wholeNumber(outcome.minimumPhotoCount ?? 0, `${path}.outcome.minimumPhotoCount`, 0, 100),
      requiredSlots: Array.isArray(outcome.requiredSlots)
        ? outcome.requiredSlots.map((slot, slotIndex) =>
            decodeSlot(slot, `${path}.outcome.requiredSlots[${slotIndex}]`),
          )
        : [],
      sellerTrust: sellerTrust
        ? {
            satisfaction: "any",
            minimumReviewCount: sellerTrustMinimumReviewCount,
            acceptedBadgeKeys,
          }
        : null,
      buyerAcknowledgment: outcome.buyerAcknowledgment === "required" ? "required" : "none",
    },
  };
}

export function decodeListingEvidencePolicyValue(raw: JsonValue): ListingEvidencePolicyValue {
  const record = recordOf(raw, "Listing Evidence Policy");
  assert(record.schemaVersion === 1, "Listing Evidence Policy schemaVersion must be 1.");
  const lifecycle = String(record.lifecycle ?? "");
  assert(
    ["draft", "validated", "active", "superseded", "rejected"].includes(lifecycle),
    "Listing Evidence Policy lifecycle is invalid.",
  );
  assert(Array.isArray(record.rules), "Listing Evidence Policy rules must be a list.");
  const rules = record.rules
    .map(decodeRule)
    .sort((left, right) => left.priority - right.priority || left.ruleId.localeCompare(right.ruleId));
  const validationRecord =
    record.validation === null || record.validation === undefined
      ? null
      : recordOf(record.validation, "Listing Evidence Policy validation");
  const result: ListingEvidencePolicyValue = {
    schemaVersion: 1,
    policyName: text(record.policyName, "Listing Evidence Policy name"),
    lifecycle: lifecycle as ListingEvidencePolicyLifecycle,
    sourcePolicyDocumentId: nullableText(record.sourcePolicyDocumentId),
    validation: validationRecord
      ? {
          validatedAt: text(validationRecord.validatedAt, "Listing Evidence Policy validation time"),
          policyHash: text(validationRecord.policyHash, "Listing Evidence Policy validation hash"),
          impactPreviewHash: text(validationRecord.impactPreviewHash, "Listing Evidence Policy impact preview hash"),
        }
      : null,
    rules,
  };
  const diagnostics = validateListingEvidencePolicy(result);
  assert(diagnostics.length === 0, diagnostics.map((diagnostic) => diagnostic.message).join(" "));
  return result;
}

export function validateListingEvidencePolicy(
  value: ListingEvidencePolicyValue,
): readonly ListingEvidencePolicyDiagnostic[] {
  const diagnostics: ListingEvidencePolicyDiagnostic[] = [];
  const ruleIds = new Set<string>();
  const policySlots = new Map<string, Readonly<{ slot: ListingEvidenceSlotRequirement; ruleId: string }>>();
  for (const [ruleIndex, rule] of value.rules.entries()) {
    if (ruleIds.has(rule.ruleId)) {
      diagnostics.push({
        code: "duplicate_rule_id",
        path: `rules[${ruleIndex}].ruleId`,
        message: `Rule id '${rule.ruleId}' is duplicated.`,
      });
    }
    ruleIds.add(rule.ruleId);
    const slots = new Map<string, ListingEvidenceSlotRequirement>();
    for (const [slotIndex, slot] of rule.outcome.requiredSlots.entries()) {
      const existing = slots.get(slot.slotId);
      if (existing && JSON.stringify(existing) !== JSON.stringify(slot)) {
        diagnostics.push({
          code: "conflicting_slot",
          path: `rules[${ruleIndex}].outcome.requiredSlots[${slotIndex}]`,
          message: `Evidence slot '${slot.slotId}' has conflicting requirements in rule '${rule.ruleId}'.`,
        });
      }
      slots.set(slot.slotId, slot);
      const policySlot = policySlots.get(slot.slotId);
      if (policySlot && policySlot.slot.viewKind !== slot.viewKind) {
        diagnostics.push({
          code: "conflicting_policy_slot",
          path: `rules[${ruleIndex}].outcome.requiredSlots[${slotIndex}]`,
          message: `Evidence slot '${slot.slotId}' uses view kind '${policySlot.slot.viewKind}' in rule '${policySlot.ruleId}' and '${slot.viewKind}' in rule '${rule.ruleId}'. Use different slot ids or one view kind.`,
        });
      }
      policySlots.set(slot.slotId, { slot, ruleId: rule.ruleId });
    }
  }
  return diagnostics;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function listingEvidencePolicyHash(value: Pick<ListingEvidencePolicyValue, "schemaVersion" | "rules">): string {
  return `sha256:${createHash("sha256")
    .update(stableStringify({ schemaVersion: value.schemaVersion, rules: value.rules }))
    .digest("hex")}`;
}

function includesOrEmpty(values: readonly string[], value: string | null): boolean {
  return values.length === 0 || (value !== null && values.includes(value));
}

export function listingEvidenceRuleMatches(
  rule: ListingEvidencePolicyRule,
  facts: ListingEvidenceEvaluationFacts,
): boolean {
  const selector = rule.selector;
  if (!includesOrEmpty(selector.catalogItemIds, facts.catalogItemId)) return false;
  if (!includesOrEmpty(selector.productIds, facts.productId)) return false;
  if (!includesOrEmpty(selector.blueprintIds, facts.blueprintId)) return false;
  if (selector.categoryIds.length > 0 && !selector.categoryIds.some((id) => facts.categoryIds.includes(id)))
    return false;
  if (
    selector.options.some(
      (required) =>
        !facts.selectedOptions.some(
          (selected) => selected.dimensionId === required.dimensionId && selected.optionId === required.optionId,
        ),
    )
  )
    return false;
  if (selector.gradedItem !== null && selector.gradedItem !== facts.gradedItem) return false;
  const priceCents = tryMoneyToCents(facts.priceAmount);
  if (priceCents === null) return false;
  if (selector.priceBand?.minimumAmount && priceCents < tryMoneyToCents(selector.priceBand.minimumAmount)!)
    return false;
  if (selector.priceBand?.maximumAmount && priceCents >= tryMoneyToCents(selector.priceBand.maximumAmount)!)
    return false;
  if (selector.seller.minimumReviewCount !== null && facts.seller.reviewCount < selector.seller.minimumReviewCount)
    return false;
  if (
    selector.seller.badgeKeys.length > 0 &&
    !selector.seller.badgeKeys.some((badge) => facts.seller.badgeKeys.includes(badge))
  )
    return false;
  if (!includesOrEmpty(selector.seller.riskLevels, facts.seller.riskLevel)) return false;
  return true;
}

export function evaluateListingEvidencePolicy(
  policy: ListingEvidencePolicyValue,
  facts: ListingEvidenceEvaluationFacts,
  metadata: Readonly<{
    policyId: string | null;
    policyVersion: number | null;
    effectiveFrom: string | null;
    effectiveUntil: string | null;
  }>,
): ListingEvidencePolicyEvaluation {
  const matched = policy.rules.filter((rule) => listingEvidenceRuleMatches(rule, facts));
  const slots = new Map<string, ListingEvidenceSlotRequirement>();
  const diagnostics: ListingEvidencePolicyDiagnostic[] = [];
  for (const rule of matched) {
    for (const slot of rule.outcome.requiredSlots) {
      const existing = slots.get(slot.slotId);
      if (existing && existing.viewKind !== slot.viewKind) {
        diagnostics.push({
          code: "conflicting_matched_slot",
          path: `rules.${rule.ruleId}`,
          message: `Matched rules assign incompatible view kinds to slot '${slot.slotId}'.`,
        });
        continue;
      }
      slots.set(
        slot.slotId,
        existing
          ? {
              ...existing,
              minimumWidthPixels: Math.max(existing.minimumWidthPixels ?? 0, slot.minimumWidthPixels ?? 0) || null,
              minimumHeightPixels: Math.max(existing.minimumHeightPixels ?? 0, slot.minimumHeightPixels ?? 0) || null,
              maximumAgeHours:
                existing.maximumAgeHours === null
                  ? slot.maximumAgeHours
                  : slot.maximumAgeHours === null
                    ? existing.maximumAgeHours
                    : Math.min(existing.maximumAgeHours, slot.maximumAgeHours),
            }
          : slot,
      );
    }
  }
  assert(diagnostics.length === 0, diagnostics.map((diagnostic) => diagnostic.message).join(" "));
  const requiredSlots = [...slots.values()].sort((left, right) => left.slotId.localeCompare(right.slotId));
  return {
    policyId: metadata.policyId,
    policyVersion: metadata.policyVersion,
    policyHash: listingEvidencePolicyHash(policy),
    matchedRuleIds: matched.map((rule) => rule.ruleId),
    requirements: {
      minimumPhotoCount: Math.max(requiredSlots.length, ...matched.map((rule) => rule.outcome.minimumPhotoCount), 0),
      requiredSlots,
      sellerTrustRequirements: matched.flatMap((rule) =>
        rule.outcome.sellerTrust ? [{ ruleId: rule.ruleId, ...rule.outcome.sellerTrust }] : [],
      ),
      buyerAcknowledgment: matched.some((rule) => rule.outcome.buyerAcknowledgment === "required")
        ? "required"
        : "none",
    },
    effectiveInterval: { from: metadata.effectiveFrom, until: metadata.effectiveUntil },
    explanationCodes: [...new Set(matched.map((rule) => rule.explanationCode))],
  };
}

const emptySelector: ListingEvidenceSelector = {
  catalogItemIds: [],
  productIds: [],
  blueprintIds: [],
  categoryIds: [],
  options: [],
  gradedItem: null,
  priceBand: null,
  seller: { minimumReviewCount: null, badgeKeys: [], riskLevels: [] },
};

export const LISTING_EVIDENCE_LAUNCH_POLICY_VALUE: ListingEvidencePolicyValue = {
  schemaVersion: 1,
  policyName: "Marketplace Listing Evidence Policy",
  lifecycle: "active",
  sourcePolicyDocumentId: null,
  validation: null,
  rules: [
    {
      ruleId: "condition-mint",
      explanationCode: "listing-evidence.condition-evidence",
      priority: 100,
      selector: {
        ...emptySelector,
        options: [
          {
            dimensionId: catalogSeedIds.dimensions.condition.dimensionId,
            optionId: catalogSeedIds.dimensions.condition.optionIds.mint,
          },
        ],
      },
      outcome: {
        minimumPhotoCount: 1,
        requiredSlots: [
          {
            slotId: "condition",
            viewKind: "condition",
            minimumWidthPixels: null,
            minimumHeightPixels: null,
            maximumAgeHours: null,
          },
        ],
        sellerTrust: null,
        buyerAcknowledgment: "none",
      },
    },
    {
      ruleId: "condition-pristine",
      explanationCode: "listing-evidence.condition-evidence",
      priority: 110,
      selector: {
        ...emptySelector,
        options: [
          {
            dimensionId: catalogSeedIds.dimensions.condition.dimensionId,
            optionId: catalogSeedIds.dimensions.condition.optionIds.pristine,
          },
        ],
      },
      outcome: {
        minimumPhotoCount: 1,
        requiredSlots: [
          {
            slotId: "condition",
            viewKind: "condition",
            minimumWidthPixels: null,
            minimumHeightPixels: null,
            maximumAgeHours: null,
          },
        ],
        sellerTrust: null,
        buyerAcknowledgment: "none",
      },
    },
    {
      ruleId: "graded-item-views",
      explanationCode: "listing-evidence.graded-item",
      priority: 200,
      selector: { ...emptySelector, gradedItem: true },
      outcome: {
        minimumPhotoCount: 3,
        requiredSlots: [
          {
            slotId: "slab",
            viewKind: "slab",
            minimumWidthPixels: null,
            minimumHeightPixels: null,
            maximumAgeHours: null,
          },
          {
            slotId: "front",
            viewKind: "front",
            minimumWidthPixels: null,
            minimumHeightPixels: null,
            maximumAgeHours: null,
          },
          {
            slotId: "back",
            viewKind: "back",
            minimumWidthPixels: null,
            minimumHeightPixels: null,
            maximumAgeHours: null,
          },
        ],
        sellerTrust: null,
        buyerAcknowledgment: "none",
      },
    },
    {
      ruleId: "high-dollar-evidence",
      explanationCode: "listing-evidence.high-dollar",
      priority: 300,
      selector: { ...emptySelector, priceBand: { minimumAmount: "250.00", maximumAmount: null } },
      outcome: {
        minimumPhotoCount: 1,
        requiredSlots: [],
        sellerTrust: { satisfaction: "any", minimumReviewCount: 3, acceptedBadgeKeys: ["trusted-seller"] },
        buyerAcknowledgment: "none",
      },
    },
  ],
};

export const marketplaceListingEvidencePolicy: PolicyDefinition<ListingEvidencePolicyValue> = definePolicy({
  policyKey: LISTING_EVIDENCE_POLICY_KEY,
  contextName: "marketplace",
  schemaSummary:
    "Guided Listing Evidence Policy v1: stable identity/trait/price/seller selectors with additive photo-slot, image, trust, and acknowledgment requirements",
  defaultValue: LISTING_EVIDENCE_LAUNCH_POLICY_VALUE,
  decodeValue: decodeListingEvidencePolicyValue,
});
