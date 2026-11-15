import { readFileSync, writeFileSync } from "node:fs";
import type { TcgplayerSealedProductDetail } from "../../../../operator-session/domain/extension/sealed-products/contract";
import { buildTcgplayerAutomationSourceObservationPayload } from "../../providers/tcgplayer/adapter";
import { tcgplayerLorcanaSealedProductProviderProfile } from "../../providers/tcgplayer/profiles";
import { catalogProviderRequiredFixtureFlows } from "../../providers/provider-integration-mapping-contract";

for (const flow of catalogProviderRequiredFixtureFlows) {
  const prior = JSON.parse(readFileSync(new URL(`prior-2026.06.23/${flow}.json`, import.meta.url), "utf8"));
  const detail: TcgplayerSealedProductDetail = {
    productId: prior.productId,
    productName: flow === "changed" ? `${prior.productName} Updated` : prior.productName,
    productLineId: prior.productLineId,
    productLineName: prior.productLineName,
    productTypeName: prior.productTypeName,
    setId: 1001,
    setCode: "TFC",
    setName: prior.setName,
    rarityName: "Sealed",
    sealed: true,
    productStatusId: 1,
    customAttributes: prior.customAttributes,
    barcode: flow === "partial" ? undefined : prior.barcode,
    formattedAttributes: {},
    skus: prior.externalProductReferences.map((reference: { externalKey: string }) => ({
      sku: Number(reference.externalKey.slice(4)) % 2_147_483_647,
      condition: "Sealed",
      variant: "Sealed",
      language: flow === "unknown-option" ? "Inklands" : "English",
    })),
  };
  const payload = buildTcgplayerAutomationSourceObservationPayload({
    detail,
    externalReferenceRules: tcgplayerLorcanaSealedProductProviderProfile.externalReferenceExtractionRules.rules,
    selectedOptionMapping: tcgplayerLorcanaSealedProductProviderProfile.selectedOptionMapping,
  });
  writeFileSync(new URL(`${flow}.json`, import.meta.url), JSON.stringify(payload, null, 2) + "\n");
}
