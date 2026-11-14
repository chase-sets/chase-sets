import { describe, expect, it } from "vitest";
import {
  assertProductCoordinateImportAllowed,
  productCoordinateImportRefusal,
} from "./product-coordinate-import-guard";
import { isIntegrationJobValidationError } from "../route-modules/route-helpers";
import {
  catalogProviderProfileVersionIngestionUnitKey,
  listCatalogProviderIntegrationProfileVersions,
} from "./registry";

const versions = listCatalogProviderIntegrationProfileVersions();
const sealed = versions.find(
  (version) =>
    version.active &&
    version.providerKey === "ygojson" &&
    catalogProviderProfileVersionIngestionUnitKey(version).includes(":sealed-product:"),
);
const cards = versions.find((version) => version.active && version.providerKey === "tcgdex");
if (!sealed || !cards) {
  throw new Error("The registry should hold active ygojson and tcgdex profiles.");
}
const sealedUnit = catalogProviderProfileVersionIngestionUnitKey(sealed);
const product = { provider: "ygojson", ingestionUnitKey: sealedUnit, language: "en", productId: "sealed-1" };

describe("assertProductCoordinateImportAllowed", () => {
  it("allows a product the active profile imports on its own, and any scope without a product", () => {
    expect(() => assertProductCoordinateImportAllowed(product, sealed)).not.toThrow();
    expect(() => assertProductCoordinateImportAllowed({ provider: "tcgdex", setId: "base1" }, cards)).not.toThrow();
  });

  it("refuses a product whose profile, unit or language does not allow it", () => {
    expect(() =>
      assertProductCoordinateImportAllowed({ ...product, provider: "tcgdex", ingestionUnitKey: undefined }, cards),
    ).toThrow(productCoordinateImportRefusal);
    expect(() => assertProductCoordinateImportAllowed({ ...product, ingestionUnitKey: undefined }, sealed)).toThrow(
      productCoordinateImportRefusal,
    );
    expect(() =>
      assertProductCoordinateImportAllowed({ ...product, ingestionUnitKey: "ygojson:yugioh:other" }, sealed),
    ).toThrow(productCoordinateImportRefusal);
    expect(() => assertProductCoordinateImportAllowed({ ...product, language: "ja" }, sealed)).toThrow(
      productCoordinateImportRefusal,
    );
    expect(() => assertProductCoordinateImportAllowed({ ...product, language: undefined }, sealed)).toThrow(
      productCoordinateImportRefusal,
    );
  });

  it("is answered as a 400 invalid_scope by the integration job routes", () => {
    expect(isIntegrationJobValidationError(new Error(productCoordinateImportRefusal))).toBe(true);
  });

  it("refuses a product mixed with an expansion, set name, series or product line", () => {
    for (const mixed of [{ setId: "lob" }, { setName: "Legend" }, { seriesId: "s1" }, { productLineId: "2" }]) {
      expect(() => assertProductCoordinateImportAllowed({ ...product, ...mixed }, sealed)).toThrow(
        productCoordinateImportRefusal,
      );
    }
  });
});
