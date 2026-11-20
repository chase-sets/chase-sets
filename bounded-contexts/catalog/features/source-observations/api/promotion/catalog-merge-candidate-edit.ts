import type { JsonObject } from "@chase-sets/primitives/json";
import {
  catalogMergeCandidateEditableFactKeys,
  type CatalogMergeCandidatePromotionIntent,
} from "../../domain/catalog-merge-candidate";
import type { CatalogMergeCandidateListRow } from "../../read-model/queries";
import { snapshotFromReviewRow } from "./catalog-merge-candidate-review-command-payloads";

// Candidate edit form. The read model exposes the editable surface for one
// candidate; the page posts the operator's typed edit, and the Catalog API's
// merge-candidate runtime applies it to the candidate's stored snapshot
// (`updateCatalogMergeCandidate`), recording field corrections as `manual`
// provenance.

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
// membership provenance) `editable` is false and `candidateVersion` is null; the
// form renders a blocked explanation instead of inputs. `candidateVersion` is the
// version the form names when it submits, so the Catalog API refuses an edit made
// from a read the candidate has since moved on from.
export type CatalogMergeCandidateEditFormModel = Readonly<{
  editable: boolean;
  candidateVersion: number | null;
  promotionIntent: CatalogMergeCandidatePromotionIntent;
  catalogItemId: string | null;
  productIds: readonly string[];
  editableFacts: readonly CatalogMergeCandidateEditFieldOverride[];
  externalCatalogItemReferences: readonly CatalogMergeCandidateEditReference[];
  externalProductReferences: readonly CatalogMergeCandidateEditReference[];
}>;

// The structured operator edit, parsed from the submitted form. Field overrides
// only carry the values the operator changed; unchanged fields keep their source
// provenance. Dropped-reference indexes point at the stored snapshot's reference
// arrays (the read model renders them in the same order).
export type CatalogMergeCandidateEditInput = Readonly<{
  promotionIntent: CatalogMergeCandidatePromotionIntent;
  catalogItemId: string | null;
  productIds: readonly string[];
  factOverrides: readonly Readonly<{ key: string; value: string }>[];
  droppedExternalCatalogItemReferenceIndexes: readonly number[];
  droppedExternalProductReferenceIndexes: readonly number[];
}>;

// The edit a client sends the Catalog API's update command: a field it leaves out keeps the
// candidate's stored value, so an empty edit keeps the candidate as it is.
export type CatalogMergeCandidateEditRequest = Partial<CatalogMergeCandidateEditInput>;

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
      candidateVersion: null,
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
    candidateVersion: editable ? candidate.last_stream_version : null,
    promotionIntent: base.promotionIntent,
    catalogItemId: base.matches.catalogItemId,
    productIds: [...base.matches.productIds],
    editableFacts: editableFactsFrom(base.proposedCatalogItemFacts),
    externalCatalogItemReferences: base.proposedExternalCatalogItemReferences.map((reference, index) => ({
      index,
      label: externalCatalogItemReferenceLabel(reference.providerKey, reference.externalKey),
    })),
    externalProductReferences: base.proposedExternalProductReferences.map((reference, index) => ({
      index,
      label: externalProductReferenceLabel(reference.providerKey, reference.externalKey, reference.selectedOptions),
    })),
  };
}

// The operator's edit from the submitted edit form, for the Catalog API's update command. Each
// fact input sits beside a hidden copy of the value the page showed
// (`candidateEditFactShown.<key>`), so only the facts the operator changed become overrides. A form
// without the mapping fields (the row's update button) sends an empty edit, which keeps the
// candidate as it is. The Catalog API applies the edit to the snapshot it holds.
export function catalogMergeCandidateEditRequestFromFormData(formData: FormData): CatalogMergeCandidateEditRequest {
  const factOverrides: { key: string; value: string }[] = [];
  for (const [name, value] of formData.entries()) {
    if (!name.startsWith(factFieldPrefix) || typeof value !== "string") {
      continue;
    }
    const key = name.slice(factFieldPrefix.length);
    const shown = formData.get(`${shownFactFieldPrefix}${key}`);
    if (key && typeof shown === "string" && shown !== value) {
      factOverrides.push({ key, value });
    }
  }

  const promotionIntent = stringField(formData, "candidateEditPromotionIntent");
  return {
    ...(promotionIntents.includes(promotionIntent as CatalogMergeCandidatePromotionIntent)
      ? { promotionIntent: promotionIntent as CatalogMergeCandidatePromotionIntent }
      : {}),
    ...(formData.has("candidateEditCatalogItemId")
      ? { catalogItemId: stringField(formData, "candidateEditCatalogItemId") || null }
      : {}),
    ...(formData.has("candidateEditProductIds")
      ? { productIds: parseIdList(stringField(formData, "candidateEditProductIds")) }
      : {}),
    factOverrides,
    droppedExternalCatalogItemReferenceIndexes: droppedReferenceIndexes(formData, "candidateEditDropCatalogRef"),
    droppedExternalProductReferenceIndexes: droppedReferenceIndexes(formData, "candidateEditDropProductRef"),
  };
}

const factFieldPrefix = "candidateEditFact.";
const shownFactFieldPrefix = "candidateEditFactShown.";

function editableFactsFrom(facts: JsonObject): readonly CatalogMergeCandidateEditFieldOverride[] {
  return catalogMergeCandidateEditableFactKeys(facts).map((key) => ({
    key,
    fieldPath: `catalogItem.${key}`,
    label: key,
    value: String(facts[key] ?? ""),
  }));
}

function externalProductReferenceLabel(
  providerKey: string,
  externalKey: string,
  selectedOptions: readonly Readonly<{ dimensionId: string; optionId: string }>[],
): string {
  const referenceLabel = externalCatalogItemReferenceLabel(providerKey, externalKey);
  const options = selectedOptions.map((option) => `${option.dimensionId}:${option.optionId}`).join(", ");
  return options ? `${referenceLabel} -> ${options}` : referenceLabel;
}

function externalCatalogItemReferenceLabel(providerKey: string, externalKey: string): string {
  return [providerKey, externalKey].join(":");
}

// The reference indexes whose drop box the operator checked (`<prefix>.<index>`).
function droppedReferenceIndexes(formData: FormData, prefix: string): readonly number[] {
  const dropped = new Set<number>();
  for (const name of formData.keys()) {
    if (!name.startsWith(`${prefix}.`)) {
      continue;
    }
    const index = Number(name.slice(prefix.length + 1));
    if (Number.isSafeInteger(index) && index >= 0) {
      dropped.add(index);
    }
  }
  return [...dropped].sort((left, right) => left - right);
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
