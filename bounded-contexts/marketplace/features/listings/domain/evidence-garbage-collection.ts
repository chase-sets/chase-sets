/**
 * Listing Evidence storage lifecycle / garbage collection.
 *
 * Current (active) evidence stays available while a Listing can transact.
 * Commitment-referenced revisions stay available for the order/support
 * retention window (their source hashes are supplied in
 * `referencedSourceHashes`). Replaced and removed assets that are no longer
 * referenced become garbage-collection candidates only after a safe delay,
 * so an accidental removal can be recovered and an in-flight commitment can
 * never lose its evidence. Selection is pure and deterministic; the deletion
 * job that consumes it is idempotent (deleting already-absent keys is a
 * no-op) and observable (it returns a report).
 *
 * Dedup safety: the same source bytes can back several entries (identical
 * upload), so a retired entry whose source hash is still referenced by any
 * active entry or commitment is retained, never collected.
 */
export type EvidenceGarbageCollectionEntry = Readonly<{
  photoId: string;
  status: "active" | "replaced" | "removed";
  /** When the entry left `active`; null when unknown (never collected). */
  retiredAt: string | null;
  sourceHash: string;
  storageKeys: readonly string[];
}>;

export type EvidenceGarbageCollectionInput = Readonly<{
  entries: readonly EvidenceGarbageCollectionEntry[];
  /** Source hashes that must be retained: every active entry plus every commitment snapshot. */
  referencedSourceHashes: ReadonlySet<string>;
  now: string;
  safeDelayHours: number;
}>;

export type EvidenceGarbageCollectionTarget = Readonly<{
  photoId: string;
  storageKeys: readonly string[];
}>;

export type EvidenceGarbageCollectionPlan = Readonly<{
  targets: readonly EvidenceGarbageCollectionTarget[];
  /** Retired entries kept because their source is still referenced. */
  retainedReferencedPhotoIds: readonly string[];
  /** Retired entries not yet past the safe delay. */
  deferredPhotoIds: readonly string[];
}>;

export function selectEvidenceGarbageCollectionTargets(
  input: EvidenceGarbageCollectionInput,
): EvidenceGarbageCollectionPlan {
  const nowMs = Date.parse(input.now);
  const safeDelayMs = Math.max(0, input.safeDelayHours) * 60 * 60 * 1000;

  const targets: EvidenceGarbageCollectionTarget[] = [];
  const retainedReferencedPhotoIds: string[] = [];
  const deferredPhotoIds: string[] = [];

  for (const entry of input.entries) {
    if (entry.status === "active") {
      continue;
    }
    if (input.referencedSourceHashes.has(entry.sourceHash)) {
      retainedReferencedPhotoIds.push(entry.photoId);
      continue;
    }
    if (entry.retiredAt === null) {
      deferredPhotoIds.push(entry.photoId);
      continue;
    }
    const retiredMs = Date.parse(entry.retiredAt);
    const pastSafeDelay = !Number.isNaN(retiredMs) && !Number.isNaN(nowMs) && nowMs - retiredMs >= safeDelayMs;
    if (pastSafeDelay) {
      targets.push({ photoId: entry.photoId, storageKeys: entry.storageKeys });
    } else {
      deferredPhotoIds.push(entry.photoId);
    }
  }

  return {
    targets: targets.sort((left, right) => left.photoId.localeCompare(right.photoId)),
    retainedReferencedPhotoIds: retainedReferencedPhotoIds.sort(),
    deferredPhotoIds: deferredPhotoIds.sort(),
  };
}
