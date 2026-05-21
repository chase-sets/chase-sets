import type { DiscoveryReferenceRecordRef, FieldValue } from "../../../support/client-support/contracts";

export type ReferenceDetailRow = Readonly<{
  id: string;
  label: string;
  value: unknown;
  reference: DiscoveryReferenceRecordRef | null;
  relationshipType: string | null;
}>;

const MAX_REFERENCE_DISPLAY_DEPTH = 4;
const ACRONYM_LABELS: Record<string, string> = {
  tcg: "TCG",
};

export function buildReferenceDetailRows(fieldValues: readonly FieldValue[]): ReferenceDetailRow[] {
  const rows: ReferenceDetailRow[] = [];
  const directReferenceIds = new Set<string>();
  const inheritedReferenceIds = new Set<string>();
  const inheritedLabelCounts = new Map<string, number>();

  for (const fieldValue of fieldValues) {
    rows.push({
      id: `field:${fieldValue.fieldId}`,
      label: resolveFieldLabel(fieldValue.fieldName),
      value: fieldValue.reference?.name ?? fieldValue.value,
      reference: fieldValue.reference ?? null,
      relationshipType: null,
    });

    if (fieldValue.reference) {
      directReferenceIds.add(fieldValue.reference.referenceId);
    }
  }

  for (const fieldValue of fieldValues) {
    if (!fieldValue.reference) {
      continue;
    }

    appendInheritedReferenceRows({
      rows,
      reference: fieldValue.reference,
      path: new Set([fieldValue.reference.referenceId]),
      directReferenceIds,
      inheritedReferenceIds,
      inheritedLabelCounts,
      depth: 0,
    });
  }

  return rows;
}

function appendInheritedReferenceRows(input: {
  rows: ReferenceDetailRow[];
  reference: DiscoveryReferenceRecordRef;
  path: ReadonlySet<string>;
  directReferenceIds: ReadonlySet<string>;
  inheritedReferenceIds: Set<string>;
  inheritedLabelCounts: Map<string, number>;
  depth: number;
}) {
  if (input.depth >= MAX_REFERENCE_DISPLAY_DEPTH) {
    return;
  }

  for (const relationship of input.reference.relationships) {
    const related = relationship.reference;

    if (!related || input.path.has(related.referenceId)) {
      continue;
    }

    if (!input.directReferenceIds.has(related.referenceId) && !input.inheritedReferenceIds.has(related.referenceId)) {
      input.rows.push({
        id: `reference:${related.referenceId}`,
        label: resolveInheritedReferenceLabel(
          related.typeKey,
          relationship.relationshipType,
          input.inheritedLabelCounts,
        ),
        value: related.name,
        reference: related,
        relationshipType: relationship.relationshipType,
      });
      input.inheritedReferenceIds.add(related.referenceId);
    }

    appendInheritedReferenceRows({
      ...input,
      reference: related,
      path: new Set([...input.path, related.referenceId]),
      depth: input.depth + 1,
    });
  }
}

function resolveInheritedReferenceLabel(typeKey: string, relationshipType: string, labelCounts: Map<string, number>) {
  const baseLabel = formatReferenceTypeLabel(typeKey);
  const count = labelCounts.get(baseLabel) ?? 0;
  labelCounts.set(baseLabel, count + 1);

  return count === 0 ? baseLabel : `${baseLabel} (${formatRelationshipLabel(relationshipType)})`;
}

export function formatReferenceTypeLabel(typeKey: string): string {
  return typeKey
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => ACRONYM_LABELS[part] ?? capitalize(part))
    .join(" ");
}

function formatRelationshipLabel(relationshipType: string): string {
  return relationshipType.split(/[-_]/g).filter(Boolean).map(capitalize).join(" ");
}

function capitalize(value: string): string {
  return value.length === 0 ? value : `${value[0].toUpperCase()}${value.slice(1)}`;
}

function resolveFieldLabel(fieldName: string): string {
  if (!looksLikeFieldIdentifier(fieldName)) {
    return fieldName;
  }

  return fieldName
    .replace(/^fld_/, "")
    .replace(/^seed_/, "")
    .split(/[-_]/g)
    .filter(Boolean)
    .map(capitalize)
    .join(" ");
}

function looksLikeFieldIdentifier(value: string): boolean {
  return /^fld[_-]/.test(value);
}
