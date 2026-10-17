import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { resolveTcgdexImageReference } from "../providers/tcgdex/image-reference";
import { recoverObservationPackAssetReferences } from "./observation-pack-asset-references";

const referenceHash = (references: readonly string[]) =>
  `sha256:${createHash("sha256")
    .update([...references].sort().join("\n"))
    .digest("hex")}`;
const pairs = Array.from({ length: 180 }, (_, index) => [
  `https://synthetic.invalid/card-${index}`,
  `https://synthetic.invalid/card-${index}/high.webp`,
]);
const candidates = pairs.flat();
const resolveHighQuality = (reference: string) => resolveTcgdexImageReference(reference, "high.webp");

describe("Observation Pack asset source-reference recovery", () => {
  it("recovers all 180 exact paired bindings among 360 candidates", () => {
    for (const pair of pairs) {
      expect(recoverObservationPackAssetReferences(candidates, referenceHash(pair), resolveHighQuality)).toEqual(pair);
    }
  });

  it("does not accept a candidate group without the exact retained hash", () => {
    expect(recoverObservationPackAssetReferences(candidates, `sha256:${"0".repeat(64)}`, resolveHighQuality)).toEqual(
      [],
    );
  });

  it("does not assume another profile variant resolves the retained group", () => {
    expect(
      recoverObservationPackAssetReferences(candidates, referenceHash(pairs[0]!), (reference) =>
        resolveTcgdexImageReference(reference, "low.webp"),
      ),
    ).toEqual([]);
  });

  it("retains the exhaustive-search cap for unrelated or unconfigured groups", () => {
    expect(recoverObservationPackAssetReferences(candidates, referenceHash(pairs[0]!))).toEqual([]);
    expect(
      recoverObservationPackAssetReferences(
        candidates,
        referenceHash([pairs[0]![0]!, pairs[1]![0]!]),
        resolveHighQuality,
      ),
    ).toEqual([]);
  });

  it("preserves all-reference, single-reference and small-subset recovery", () => {
    expect(recoverObservationPackAssetReferences(candidates, referenceHash(candidates))).toEqual(candidates);
    expect(recoverObservationPackAssetReferences(candidates, referenceHash([candidates[0]!]))).toEqual([candidates[0]]);
    const small = ["https://synthetic.invalid/a", "https://synthetic.invalid/b", "https://synthetic.invalid/c"];
    expect(recoverObservationPackAssetReferences(small, referenceHash([small[0]!, small[2]!]))).toEqual([
      small[0],
      small[2],
    ]);
  });

  it("uses the selected variant for base and already-qualified references", () => {
    const base = "https://synthetic.invalid/alternate/";
    const qualified = "https://synthetic.invalid/alternate/low.webp";
    expect(resolveTcgdexImageReference(base, "low.webp")).toBe(qualified);
    expect(resolveTcgdexImageReference(qualified, "low.webp")).toBe(qualified);
  });
});
