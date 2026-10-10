import { describe, expect, it } from "vitest";
import {
  canonicalPromotionReferenceText as canonical,
  promotionReferenceTrimCharacters,
  requirePromotionReferenceRuntime,
} from "./promotion-reference-canonicalization";
import {
  promotionCaseIgnorableRanges,
  promotionCasedRanges,
  promotionLowercaseRanges,
} from "./promotion-reference-casing-data";
import {
  promotionTargetBindingStream,
  promotionTargetKeyIdentity,
  retainedPromotionTargetBindingStream,
  sourceObservationTargetId,
} from "./promotion-target-identity";
import { decideCatalogItem, evolveCatalogItem, initialCatalogItemState } from "../../../catalog-items/domain/domain";
import type { CatalogItemId } from "../../../../ids";

describe("pinned promotion reference identity", () => {
  it("matches the supported runtime's complete scalar casing and context-property corpus", () => {
    requirePromotionReferenceRuntime();
    const mapped = new Map<number, string>();
    for (const [first, last, stride, delta] of promotionLowercaseRanges)
      for (let point = first; point <= last; point += stride) mapped.set(point, String.fromCodePoint(point + delta));
    mapped.set(304, "i\u0307");
    const cased = new Set<number>();
    const ignorable = new Set<number>();
    for (const [first, last] of promotionCasedRanges) for (let point = first; point <= last; point++) cased.add(point);
    for (const [first, last] of promotionCaseIgnorableRanges)
      for (let point = first; point <= last; point++) ignorable.add(point);
    for (let point = 1; point <= 0x10ffff; point++) {
      if (point >= 0xd800 && point <= 0xdfff) continue;
      const value = String.fromCodePoint(point);
      if (
        value.toLowerCase() !== (mapped.get(point) ?? value) ||
        /\p{Cased}/u.test(value) !== cased.has(point) ||
        /\p{Case_Ignorable}/u.test(value) !== ignorable.has(point)
      )
        throw new Error(`promotion-reference-corpus-drift:U+${point.toString(16)}`);
    }
    expect(() => requirePromotionReferenceRuntime("16.0")).toThrow("runtime-drift");
  });

  it.each([
    "\u0130",
    "A\u03a3",
    "A\u03a3A",
    "A'\u03a3\u0301",
    "\u1e9e",
    "ss",
    "\u00c9",
    "E\u0301",
    `${promotionReferenceTrimCharacters}MiXeD${promotionReferenceTrimCharacters}`,
  ])("matches both real item-domain reference levels for %s", (value) => {
    const created = decideCatalogItem(initialCatalogItemState, {
      type: "CreateCatalogItem",
      itemId: "cat_identity_control" as CatalogItemId,
      languageCode: "en",
      title: { defaultLocale: "en", values: { en: "Synthetic identity control" } },
    });
    const initial = created.reduce(evolveCatalogItem, initialCatalogItemState);
    for (const type of ["LinkExternalCatalogItemReference", "LinkExternalProductReference"] as const) {
      const events = decideCatalogItem(initial, { type, providerKey: " MixedProvider ", externalKey: value });
      expect(events).toHaveLength(1);
      expect(events[0].data).toMatchObject({
        providerKey: canonical(" MixedProvider "),
        externalKey: canonical(value),
      });
    }
    expect(canonical(canonical(value))).toBe(canonical(value));
  });

  it("coalesces only equal level-qualified tuples and never folds member IDs", () => {
    const key = { level: "item", providerKey: " A:B ", externalKey: " C " } as const;
    expect(promotionTargetBindingStream(key)).toBe(
      promotionTargetBindingStream({ ...key, providerKey: "a:b", externalKey: "c" }),
    );
    expect(promotionTargetKeyIdentity(key)).not.toBe(
      promotionTargetKeyIdentity({ ...key, providerKey: "a", externalKey: "b:c" }),
    );
    expect(promotionTargetKeyIdentity(key)).not.toBe(promotionTargetKeyIdentity({ ...key, level: "product" }));
    expect(promotionTargetBindingStream(key)).not.toBe(retainedPromotionTargetBindingStream(key));
    expect(sourceObservationTargetId("A")).not.toBe(sourceObservationTargetId("a"));
    expect(promotionTargetKeyIdentity({ level: "member", observationId: " A " })).toBe('["member"," A "]');
    for (const [left, right] of [
      ["\u0130", "i"],
      ["A\u03a3", "a\u03c3"],
      ["\u00df", "ss"],
      ["\u00c9", "E\u0301"],
    ])
      expect(canonical(left)).not.toBe(canonical(right));
    expect(canonical("\u0130".repeat(2048))).toHaveLength(4096);
    expect(() => promotionTargetKeyIdentity({ ...key, externalKey: "\u0130".repeat(2048) })).toThrow();
  });
});
