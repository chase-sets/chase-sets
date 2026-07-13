import type { JsonObject } from "@chase-sets/primitives/json";
import type {
  CatalogMergeCandidateFieldProvenance,
  CatalogMergeCandidatePromotionIntent,
  CatalogMergeCandidateReviewSnapshot,
} from "../domain/catalog-merge-candidate";
import type { CatalogMergeCandidateListRow } from "../read-model/queries";
import { snapshotFromReviewRow } from "./catalog-merge-candidate-review-command-payloads";

// Candidate edit slice (#3800). The domain already supports full candidate
// editing: UpdateCatalogMergeCandidate replaces the review snapshot with audit,
// and field provenance supports `manual` confidence. This module is the typed,
// server-owned bridge between the trimmed workbench review row and that command.
// The read model exposes a base snapshot plus the editable surface for one
// candidate; the command handler applies the operator's overrides back onto that
// base snapshot before submitting the update. Operator field corrections are
// recorded as `manual` provenance anchored to a real membership observation so
// the domain's provenance invariant (every entry carries a concrete source) still
// holds while promotion carries the edited value forward.

export type CatalogMergeCandidateEditFieldOverride = Readonly<{
  key: string;
  fieldPath: string;
  label: string;
  value: string;
}>;

export type CatalogMergeCandidateEditReference = Readonly<{
  index: number;
  label: string;
}>;

// The editable surface of one candidate, ready to render as a typed form. When a
// candidate cannot be edited (no manage permission, terminal, or missing
// membership provenance) `editable` is false and `baseSnapshotJson` is null; the
// form renders a blocked explanation instead of inputs.
export type CatalogMergeCandidateEditFormModel = Readonly<{
  editable: boolean;
  baseSnapshotJson: string | null;
  promotionIntent: CatalogMergeCandidatePromotionIntent;
  catalogItemId: string | null;
  productIds: readonly string[];
  editableFacts: readonly CatalogMergeCandidateEditFieldOverride[];
  externalCatalogItemReferences: readonly CatalogMergeCandidateEditReference[];
  externalProductReferences: readonly CatalogMergeCandidateEditReference[];
}>;

// The structured operator edit, parsed from the submitted form. Field overrides
// only carry the values the operator changed; unchanged fields keep their source
// provenance. Dropped-reference indexes point at the base snapshot's reference
// arrays (the read model renders them in the same order).
export type CatalogMergeCandidateEditInput = Readonly<{
  promotionIntent: CatalogMergeCandidatePromotionIntent;
  catalogItemId: string | null;
  productIds: readonly string[];
  factOverrides: readonly Readonly<{ key: string; value: string }>[];
  droppedExternalCatalogItemReferenceIndexes: readonly number[];
  droppedExternalProductReferenceIndexes: readonly number[];
}>;

const promotionIntents: readonly CatalogMergeCandidatePromotionIntent[] = [
  "create-catalog-item",
  "update-catalog-item",
  "link-existing-catalog-item",
];

// Build the editable surface for one candidate. Terminal (promoted/rejected) and
// membership-less candidates are not editable — the domain rejects an update on a
// terminal candidate and cannot rebuild a snapshot without membership provenance.
export function catalogMergeCandidateEditFormFor(
  candidate: CatalogMergeCandidateListRow,
  options: Readonly<{ canManage: boolean }>,
): CatalogMergeCandidateEditFormModel {
  const base = snapshotFromReviewRow(candidate);
  const terminal = candidate.status === "promoted" || candidate.status === "rejected";
  const editable = options.canManage && !terminal && base !== null;

  if (!base) {
    return {
      editable: false,
      baseSnapshotJson: null,
      promotionIntent: candidate.promotion_intent,
      catalogItemId: candidate.matched_catalog_item_id,
      productIds: [...candidate.matched_product_ids_json],
      editableFacts: [],
      externalCatalogItemReferences: [],
      externalProductReferences: [],
    };
  }

  return {
    editable,
    baseSnapshotJson: editable ? JSON.stringify(base) : null,
    promotionIntent: base.promotionIntent,
    catalogItemId: base.matches.catalogItemId,
    productIds: [...base.matches.productIds],
    editableFacts: editableFactsFrom(base.proposedCatalogItemFacts),
    externalCatalogItemReferences: base.proposedExternalCatalogItemReferences.map((reference, index) => ({
      index,
      label: `${reference.providerKey}:${reference.externalKey}`,
    })),
    externalProductReferences: base.proposedExternalProductReferences.map((reference, index) => ({
      index,
      label: externalProductReferenceLabel(reference.providerKey, reference.externalKey, reference.selectedOptions),
    })),
  };
}

// Apply the operator's edit onto the base snapshot, producing the replacement
// snapshot the UpdateCatalogMergeCandidate command carries. Field overrides update
// the proposed facts and add a `manual` provenance entry anchored to the first
// membership observation, so promotion carries the corrected value and the
// provenance trail shows an operator correction.
export function applyCatalogMergeCandidateEdit(
  base: CatalogMergeCandidateReviewSnapshot,
  edit: CatalogMergeCandidateEditInput,
): CatalogMergeCandidateReviewSnapshot {
  const anchor = base.membership[0];
  if (!anchor) {
    throw new Error("Catalog Merge Candidate edit requires at least one Source Observation.");
  }

  const droppedCatalogItemRefs = new Set(edit.droppedExternalCatalogItemReferenceIndexes);
  const droppedProductRefs = new Set(edit.droppedExternalProductReferenceIndexes);

  let proposedCatalogItemFacts: JsonObject = { ...base.proposedCatalogItemFacts };
  let fieldProvenance: readonly CatalogMergeCandidateFieldProvenance[] = base.fieldProvenance;

  for (const override of edit.factOverrides) {
    const key = override.key.trim();
    if (!key) {
      continue;
    }
    const fieldPath = `catalogItem.${key}`;
    proposedCatalogItemFacts = { ...proposedCatalogItemFacts, [key]: override.value };
    fieldProvenance = [
      ...fieldProvenance.filter((entry) => entry.fieldPath !== fieldPath),
      {
        fieldPath,
        value: override.value,
        observationId: anchor.observationId,
        providerKey: anchor.providerKey,
        sourceProfileKey: anchor.sourceProfileKey,
        sourceProfileVersion: anchor.sourceProfileVersion,
        confidence: "manual",
        evidence: { operatorCorrection: true },
      },
    ];
  }

  return {
    ...base,
    matches: {
      catalogItemId: edit.catalogItemId?.trim() || null,
      productIds: normalizeIdList(edit.productIds),
    },
    proposedCatalogItemFacts,
    proposedExternalCatalogItemReferences: base.proposedExternalCatalogItemReferences.filter(
      (_reference, index) => !droppedCatalogItemRefs.has(index),
    ),
    proposedExternalProductReferences: base.proposedExternalProductReferences.filter(
      (_reference, index) => !droppedProductRefs.has(index),
    ),
    fieldProvenance,
    promotionIntent: edit.promotionIntent,
  };
}

// Reconstruct the operator's edit from submitted form fields against the base
// snapshot. The base tells us which fact keys are editable and how many
// references exist, so the parser never trusts arbitrary form keys.
export function catalogMergeCandidateEditInputFromFormData(
  base: CatalogMergeCandidateReviewSnapshot,
  formData: FormData,
): CatalogMergeCandidateEditInput {
  const factOverrides: { key: string; value: string }[] = [];
  for (const key of editableFactKeys(base.proposedCatalogItemFacts)) {
    const field = formData.get(`candidateEditFact.${key}`);
    if (typeof field !== "string") {
      continue;
    }
    const current = base.proposedCatalogItemFacts[key];
    if (typeof current === "string" && field !== current) {
      factOverrides.push({ key, value: field });
    }
  }

  return {
    promotionIntent: promotionIntentFromFormData(formData, base.promotionIntent),
    catalogItemId: stringField(formData, "candidateEditCatalogItemId") || null,
    productIds: parseIdList(stringField(formData, "candidateEditProductIds")),
    factOverrides,
    droppedExternalCatalogItemReferenceIndexes: droppedReferenceIndexes(
      formData,
      "candidateEditDropCatalogRef",
      base.proposedExternalCatalogItemReferences.length,
    ),
    droppedExternalProductReferenceIndexes: droppedReferenceIndexes(
      formData,
      "candidateEditDropProductRef",
      base.proposedExternalProductReferences.length,
    ),
  };
}

// Parse the embedded base snapshot and apply the submitted edit, or null when no
// edit-form base snapshot was posted (the caller then falls back to the typed
// command-preview update path). Malformed JSON fails closed with null.
export function editedSnapshotFromFormData(formData: FormData): CatalogMergeCandidateReviewSnapshot | null {
  const raw = stringField(formData, "candidateEditBaseSnapshot");
  if (!raw) {
    return null;
  }

  let base: CatalogMergeCandidateReviewSnapshot;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    base = parsed as CatalogMergeCandidateReviewSnapshot;
  } catch {
    return null;
  }

  if (!Array.isArray(base.membership) || base.membership.length === 0) {
    return null;
  }

  return applyCatalogMergeCandidateEdit(base, catalogMergeCandidateEditInputFromFormData(base, formData));
}

function editableFactsFrom(facts: JsonObject): readonly CatalogMergeCandidateEditFieldOverride[] {
  return editableFactKeys(facts).map((key) => ({
    key,
    fieldPath: `catalogItem.${key}`,
    label: key,
    value: String(facts[key] ?? ""),
  }));
}

// Only string-valued facts are safely editable as free text; structured facts
// keep their provider provenance and are not surfaced as text inputs.
function editableFactKeys(facts: JsonObject): readonly string[] {
  return Object.keys(facts)
    .filter((key) => typeof facts[key] === "string")
    .sort();
}

function externalProductReferenceLabel(
  providerKey: string,
  externalKey: string,
  selectedOptions: readonly Readonly<{ dimensionId: string; optionId: string }>[],
): string {
  const options = selectedOptions.map((option) => `${option.dimensionId}:${option.optionId}`).join(", ");
  return options ? `${providerKey}:${externalKey} -> ${options}` : `${providerKey}:${externalKey}`;
}

function promotionIntentFromFormData(
  formData: FormData,
  fallback: CatalogMergeCandidatePromotionIntent,
): CatalogMergeCandidatePromotionIntent {
  const value = stringField(formData, "candidateEditPromotionIntent");
  return promotionIntents.includes(value as CatalogMergeCandidatePromotionIntent)
    ? (value as CatalogMergeCandidatePromotionIntent)
    : fallback;
}

function droppedReferenceIndexes(formData: FormData, prefix: string, count: number): readonly number[] {
  const dropped: number[] = [];
  for (let index = 0; index < count; index += 1) {
    if (formData.has(`${prefix}.${index}`)) {
      dropped.push(index);
    }
  }
  return dropped;
}

function stringField(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function parseIdList(value: string): readonly string[] {
  return normalizeIdList(value.split(","));
}

function normalizeIdList(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      normalized.push(trimmed);
    }
  }
  return normalized;
}
