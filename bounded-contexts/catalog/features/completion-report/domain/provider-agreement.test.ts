import { describe, expect, it } from "vitest";
import { normalizedObservation } from "../../../support/test-support/source-observation-fixtures";
import type { CatalogMergeCandidateIdentity } from "../../source-observations/domain/catalog-merge-candidate";
import { classifyProviderAgreement } from "./provider-agreement";

describe("classifyProviderAgreement", () => {
  it("partitions candidates, ignores identity fallbacks, and counts differing provider pairs once", () => {
    const base = normalizedObservation({
      name: "Same",
      cardNumber: "",
      rarity: "Rare",
      barcode: null,
      mergeIdentity: {
        tcg: "pokemon",
        productLineName: "Pokemon TCG",
        setName: "Set",
        printedProductName: "Card",
        collectorNumber: "fallback-1",
        languageCode: "en",
        productForm: "fallback-form",
      },
    });
    const identity: CatalogMergeCandidateIdentity = {
      scopeRecordId: "scope_one",
      collectorNumber: "fallback-1",
      languageCode: "en",
      productForm: "fallback-form",
      variantKey: null,
      barcode: null,
    };
    const member = (providerKey: string, normalized: typeof base) => ({
      providerKey,
      row: { normalized },
      identity,
    });
    const result = classifyProviderAgreement(
      ["pokemon"],
      [
        {
          productDomain: "pokemon",
          members: [
            member("alpha", base),
            member("beta", { ...base, name: "Same" }),
            member("gamma", { ...base, name: "Different" }),
          ],
        },
        {
          productDomain: "pokemon",
          members: [member("alpha", { ...base, rarity: "A" }), member("alpha", { ...base, rarity: "B" })],
        },
        {
          productDomain: "pokemon",
          members: [member("alpha", { ...base, name: "Only" })],
        },
        { productDomain: "pokemon", members: [] },
      ],
    );

    const fields = result.pokemon.fields;
    expect(result.pokemon.candidateCount).toBe(4);
    expect(fields.name).toMatchObject({ agreed: 0, mismatch: 1, "single-source": 2, absent: 1 });
    expect(fields.name.mismatchPairs).toEqual({ "alpha|gamma": 1, "beta|gamma": 1 });
    expect(fields.rarity["intra-provider-conflict"]).toBe(1);
    expect(fields.collectorNumber.absent).toBe(4);
    expect(fields.productForm).toMatchObject({ agreed: 1, absent: 1 });
    expect(fields.barcode.absent).toBe(4);
    for (const field of Object.values(fields)) {
      expect(
        field.agreed + field["single-source"] + field.mismatch + field.absent + field["intra-provider-conflict"],
      ).toBe(4);
    }
  });
});
