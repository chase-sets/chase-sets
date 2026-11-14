import type {
  CatalogMergeCandidateConflictResolution,
  CatalogMergeCandidateReviewSnapshot,
} from "./catalog-merge-candidate";

/** Apply reviewed fact choices without changing the source evidence or merge identity. */
export function snapshotWithConflictResolutions(
  snapshot: CatalogMergeCandidateReviewSnapshot,
  resolutions: readonly CatalogMergeCandidateConflictResolution[],
): CatalogMergeCandidateReviewSnapshot {
  const facts = { ...snapshot.proposedCatalogItemFacts };
  let fieldProvenance = [...snapshot.fieldProvenance];
  for (const resolution of resolutions) {
    const fieldPath = resolution.fieldPath;
    const factKey = fieldPath?.match(/^catalogItem\.([^.]+)$/)?.[1];
    if (!factKey || !fieldPath) continue;
    const conflict = snapshot.conflicts.find((entry) => entry.code === resolution.conflictCode);
    if (conflict && conflict.fieldPath !== fieldPath) continue;
    facts[factKey] = resolution.chosenValue;
    const anchor =
      snapshot.membership.find((member) => resolution.observationIds.includes(member.observationId)) ??
      snapshot.membership[0] ??
      snapshot.fieldProvenance.find((entry) => entry.fieldPath === fieldPath);
    if (!anchor) continue;
    fieldProvenance = [
      ...fieldProvenance.filter((entry) => entry.fieldPath !== fieldPath),
      {
        fieldPath,
        value: resolution.chosenValue,
        observationId: anchor.observationId,
        providerKey: anchor.providerKey,
        sourceProfileKey: anchor.sourceProfileKey,
        sourceProfileVersion: anchor.sourceProfileVersion,
        confidence: "manual",
        evidence: {
          conflictCode: resolution.conflictCode,
          reason: resolution.reason,
          observationIds: [...resolution.observationIds],
        },
      },
    ];
  }
  return { ...snapshot, proposedCatalogItemFacts: facts, fieldProvenance };
}
