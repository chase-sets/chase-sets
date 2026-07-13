import { describe, expect, it } from "vitest";
import {
  selectEvidenceGarbageCollectionTargets,
  type EvidenceGarbageCollectionEntry,
} from "./evidence-garbage-collection";

function entry(
  overrides: Partial<EvidenceGarbageCollectionEntry> & { photoId: string },
): EvidenceGarbageCollectionEntry {
  return {
    photoId: overrides.photoId,
    status: overrides.status ?? "removed",
    retiredAt: "retiredAt" in overrides ? (overrides.retiredAt ?? null) : "2026-07-01T00:00:00.000Z",
    sourceHash: overrides.sourceHash ?? `hash_${overrides.photoId}`,
    storageKeys: overrides.storageKeys ?? [`key/${overrides.photoId}/source`, `key/${overrides.photoId}/detail`],
  };
}

const NOW = "2026-07-13T00:00:00.000Z";

describe("selectEvidenceGarbageCollectionTargets", () => {
  it("collects retired, unreferenced assets past the safe delay", () => {
    const plan = selectEvidenceGarbageCollectionTargets({
      entries: [entry({ photoId: "a", retiredAt: "2026-07-01T00:00:00.000Z" })],
      referencedSourceHashes: new Set(),
      now: NOW,
      safeDelayHours: 24,
    });
    expect(plan.targets.map((target) => target.photoId)).toEqual(["a"]);
    expect(plan.targets[0]?.storageKeys).toContain("key/a/source");
  });

  it("never collects active entries", () => {
    const plan = selectEvidenceGarbageCollectionTargets({
      entries: [entry({ photoId: "a", status: "active" })],
      referencedSourceHashes: new Set(),
      now: NOW,
      safeDelayHours: 24,
    });
    expect(plan.targets).toEqual([]);
  });

  it("retains retired assets whose source is still referenced (dedup / commitment)", () => {
    const plan = selectEvidenceGarbageCollectionTargets({
      entries: [entry({ photoId: "a", sourceHash: "shared" })],
      referencedSourceHashes: new Set(["shared"]),
      now: NOW,
      safeDelayHours: 24,
    });
    expect(plan.targets).toEqual([]);
    expect(plan.retainedReferencedPhotoIds).toEqual(["a"]);
  });

  it("defers assets still inside the safe delay window", () => {
    const plan = selectEvidenceGarbageCollectionTargets({
      entries: [entry({ photoId: "a", retiredAt: "2026-07-12T23:00:00.000Z" })],
      referencedSourceHashes: new Set(),
      now: NOW,
      safeDelayHours: 24,
    });
    expect(plan.targets).toEqual([]);
    expect(plan.deferredPhotoIds).toEqual(["a"]);
  });

  it("is idempotent: re-running over the same input yields the same targets", () => {
    const input = {
      entries: [entry({ photoId: "a" }), entry({ photoId: "b" })],
      referencedSourceHashes: new Set<string>(),
      now: NOW,
      safeDelayHours: 24,
    };
    const first = selectEvidenceGarbageCollectionTargets(input);
    const second = selectEvidenceGarbageCollectionTargets(input);
    expect(second).toEqual(first);
    expect(first.targets.map((target) => target.photoId)).toEqual(["a", "b"]);
  });

  it("never collects an entry with an unknown retirement time", () => {
    const plan = selectEvidenceGarbageCollectionTargets({
      entries: [entry({ photoId: "a", retiredAt: null })],
      referencedSourceHashes: new Set(),
      now: NOW,
      safeDelayHours: 24,
    });
    expect(plan.targets).toEqual([]);
    expect(plan.deferredPhotoIds).toEqual(["a"]);
  });
});
