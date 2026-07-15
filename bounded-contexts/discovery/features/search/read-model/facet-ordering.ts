import type { ReferenceRecordRef } from "../../../support/item-support/reference-records";

export type FieldFacetSortMetadata = Readonly<{
  sortKind: "date-desc" | "number-desc" | null;
  sortValue: string | null;
}>;

export function facetGroupDecisionPriority(input: {
  kind: "field" | "reference" | "dimension";
  id: string;
  label: string;
}): number {
  const normalized = normalizeFacetText(`${input.id} ${input.label}`);

  if (
    includesFacetTerm(normalized, "expansion") ||
    includesFacetTerm(normalized, "series") ||
    includesFacetTerm(normalized, "manufacturer") ||
    includesFacetTerm(normalized, "brand") ||
    includesFacetTerm(normalized, "product line")
  ) {
    return 100;
  }

  if (includesFacetTerm(normalized, "condition") || includesFacetTerm(normalized, "grade")) {
    return 90;
  }

  if (
    includesFacetTerm(normalized, "rarity") ||
    includesFacetTerm(normalized, "variant") ||
    includesFacetTerm(normalized, "card number") ||
    includesFacetTerm(normalized, "release year")
  ) {
    return 80;
  }

  return input.kind === "reference" ? 60 : input.kind === "dimension" ? 40 : 0;
}

export function fieldFacetSortMetadata(input: {
  fieldId: string;
  label: string;
  value: unknown;
  valueType: string;
  reference?: ReferenceRecordRef;
}): FieldFacetSortMetadata {
  const releaseDate = input.reference ? releaseDateFromReference(input.reference) : null;
  if (releaseDate) {
    return { sortKind: "date-desc", sortValue: releaseDate };
  }

  const numericValue = numericFacetValue(input.value);
  if (numericValue === null) {
    return { sortKind: null, sortValue: null };
  }

  if (isYearFacet(input.fieldId, input.label) || input.valueType === "number") {
    return { sortKind: "number-desc", sortValue: String(numericValue) };
  }

  return { sortKind: null, sortValue: null };
}

export function fieldFacetValueOrderSql(columns: {
  sortKind: string;
  sortValue: string;
  sortNumber: string;
  count: string;
  label: string;
  id: string;
}): string {
  return [
    `CASE WHEN ${columns.sortKind} = 'date-desc' THEN ${columns.sortValue} END DESC NULLS LAST`,
    `CASE WHEN ${columns.sortKind} = 'number-desc' THEN ${columns.sortNumber} END DESC NULLS LAST`,
    `${columns.count} DESC`,
    `${columns.label} ASC`,
    `${columns.id} ASC`,
  ].join(", ");
}

export function dimensionFacetValueOrderSql(columns: {
  valueKind: string;
  numericValue: string;
  displayOrder: string;
  count: string;
  label: string;
  id: string;
}): string {
  return [
    `CASE WHEN ${columns.valueKind} = 'numeric' THEN ${columns.numericValue} END DESC NULLS LAST`,
    `CASE WHEN ${columns.valueKind} IN ('ordered', 'numeric') THEN ${columns.displayOrder} END ASC NULLS LAST`,
    `${columns.count} DESC`,
    `${columns.label} ASC`,
    `${columns.id} ASC`,
  ].join(", ");
}

function releaseDateFromReference(reference: ReferenceRecordRef): string | null {
  const attributes = reference.attributes;
  if (!attributes || typeof attributes !== "object" || Array.isArray(attributes)) {
    return null;
  }

  const value = (attributes as Record<string, unknown>)["release-date"];
  if (typeof value !== "string") {
    return null;
  }

  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function numericFacetValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return null;
  }

  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function isYearFacet(fieldId: string, label: string): boolean {
  return [fieldId, label].some((value) => /\byear\b/i.test(value.replace(/[-_]+/g, " ")));
}

function includesFacetTerm(value: string, term: string): boolean {
  return value.includes(` ${term} `);
}

function normalizeFacetText(value: string): string {
  return ` ${value
    .toLowerCase()
    .replace(/[-_:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()} `;
}
