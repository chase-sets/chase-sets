import type { JsonObject } from "@chase-sets/primitives/json";
import type {
  CatalogMergeCandidateFieldProvenance,
  CatalogMergeCandidatePromotionIntent,
  CatalogMergeCandidateReviewSnapshot,
} from "../../domain/catalog-merge-candidate";
import type { CatalogMergeCandidateListRow } from "../../read-model/queries";
import { snapshotFromReviewRow } from "./catalog-merge-candidate-review-command-payloads";

// Candidate edit slice. The domain already supports full candidate
// editing: UpdateCatalogMergeCandidate replaces the review snapshot with audit,
// and field provenance supports `manual` confidence. This module is the typed,
// server-owned bridge between the trimmed workbench review row and that command.
// The read model exposes the editable surface for one candidate; the page posts
// the operator's typed edit and the Catalog API applies it to the candidate's
// stored snapshot (`updateCatalogMergeCandidate`). Operator field corrections are
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

// The full edit `request` makes of the candidate's stored snapshot `base`.
export function catalogMergeCandidateEditInputFor(
  base: CatalogMergeCandidateReviewSnapshot,
  request: CatalogMergeCandidateEditRequest,
): CatalogMergeCandidateEditInput {
  return {
    promotionIntent: request.promotionIntent ?? base.promotionIntent,
    catalogItemId: request.catalogItemId === undefined ? base.matches.catalogItemId : request.catalogItemId,
    productIds: request.productIds ?? base.matches.productIds,
    factOverrides: request.factOverrides ?? [],
    droppedExternalCatalogItemReferenceIndexes: request.droppedExternalCatalogItemReferenceIndexes ?? [],
    droppedExternalProductReferenceIndexes: request.droppedExternalProductReferenceIndexes ?? [],
  };
}

// The edit in a request body, or null when a field it carries has the wrong shape.
export function catalogMergeCandidateEditRequestFromJson(value: unknown): CatalogMergeCandidateEditRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const body = value as Record<string, unknown>;
  const request: {
    -readonly [K in keyof CatalogMergeCandidateEditRequest]: CatalogMergeCandidateEditRequest[K];
  } = {};
  if (body.promotionIntent !== undefined) {
    if (!promotionIntents.includes(body.promotionIntent as CatalogMergeCandidatePromotionIntent)) return null;
    request.promotionIntent = body.promotionIntent as CatalogMergeCandidatePromotionIntent;
  }
  if (body.catalogItemId !== undefined) {
    if (body.catalogItemId !== null && typeof body.catalogItemId !== "string") return null;
    request.catalogItemId = body.catalogItemId;
  }
  if (body.productIds !== undefined) {
    if (!isStringArray(body.productIds)) return null;
    request.productIds = body.productIds;
  }
  if (body.factOverrides !== undefined) {
    if (
      !Array.isArray(body.factOverrides) ||
      !body.factOverrides.every(
        (entry: unknown) =>
          !!entry &&
          typeof entry === "object" &&
          typeof (entry as { key?: unknown }).key === "string" &&
          typeof (entry as { value?: unknown }).value === "string",
      )
    ) {
      return null;
    }
    request.factOverrides = (body.factOverrides as readonly { key: string; value: string }[]).map((entry) => ({
      key: entry.key,
      value: entry.value,
    }));
  }
  for (const field of [
    "droppedExternalCatalogItemReferenceIndexes",
    "droppedExternalProductReferenceIndexes",
  ] as const) {
    const indexes = body[field];
    if (indexes === undefined) continue;
    if (!Array.isArray(indexes) || !indexes.every((index) => Number.isSafeInteger(index) && index >= 0)) return null;
    request[field] = indexes as readonly number[];
  }
  return request;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

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

// Apply the operator's edit onto the stored snapshot, producing the replacement
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

// Only string-valued facts are safely editable as free text; structured facts
// keep their provider provenance and are not surfaced as text inputs.
export function catalogMergeCandidateEditableFactKeys(facts: JsonObject): readonly string[] {
  return Object.keys(facts)
    .filter((key) => typeof facts[key] === "string")
    .sort();
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
