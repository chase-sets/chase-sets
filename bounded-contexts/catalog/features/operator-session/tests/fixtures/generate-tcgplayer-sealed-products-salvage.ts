// Bounded, offline fixture generator. Executes the historical pure builder, not its HTTP client.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { toJsonValue } from "@chase-sets/primitives/json";
import { extractCatalogProviderExternalReferences } from "../../../source-observations/api/promotion/provider-external-reference-extractor";
import { resolveCatalogProviderSelectedOptions } from "../../../source-observations/api/providers/provider-selected-option-resolver";
import {
  catalogProviderIntegrationProfileVersions,
  catalogProviderProfileVersionIngestionUnitKey,
  type CatalogProviderIntegrationProfileVersionRecord,
} from "../../../source-observations/api/provider-integration-profiles";
import { requireCatalogProviderSourceObservation } from "../../../source-observations/api/promotion/provider-source-observation-normalizer";
import { requireSourceObservationMappingContract } from "../../../source-observations/api/source-observation-promotion-execution";
import type { TcgplayerSealedProductDetail } from "../../domain/extension/sealed-products/contract";

const commit = "e88692696a1fab8a65870c25ba5d64ce6b47eb80";
const path =
  "bounded-contexts/catalog/features/source-observations/api/providers/tcgplayer-automation-catalog-client.ts";
const source = execFileSync("git", ["show", `${commit}:${path}`], { encoding: "utf8" });
const excerpt =
  source.slice(
    source.indexOf("export function buildTcgplayerAutomationSourceObservationPayload"),
    source.indexOf("async function listAllTcgplayerAutomationProducts"),
  ) + source.slice(source.indexOf("function skuReviewEvidence"));
if (!excerpt.startsWith("export function build") || !excerpt.includes("function normalizeTcgName"))
  throw new Error("salvage-excerpt-changed");
const build = new Function(
  "toJsonValue",
  "extractCatalogProviderExternalReferences",
  "resolveCatalogProviderSelectedOptions",
  `${stripTypeScriptTypes(excerpt.replaceAll("export function", "function"))}; return buildTcgplayerAutomationSourceObservationPayload;`,
)(toJsonValue, extractCatalogProviderExternalReferences, resolveCatalogProviderSelectedOptions);

const cases = ["mtg", "pokemon", "lorcana"].map((domain) => {
  const fixture = JSON.parse(
    readFileSync(
      new URL(
        `../../../source-observations/api/__fixtures__/tcgplayer-${domain}-sealed-product/normal.json`,
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const detail: TcgplayerSealedProductDetail = {
    productId: fixture.productId,
    productName: fixture.productName,
    productLineId: fixture.productLineId,
    productLineName: fixture.productLineName,
    productTypeName: fixture.productTypeName,
    setName: fixture.setName,
    setCode: fixture.setCode ?? "SYN",
    setId: fixture.setId ?? 1001,
    rarityName: "Sealed",
    sealed: true,
    productStatusId: 1,
    customAttributes: fixture.customAttributes,
    barcode: fixture.barcode,
    formattedAttributes: {},
    skus: fixture.externalProductReferences.map((reference: { externalKey: string }) => ({
      // The retained Lorcana profile fixture has an over-int32 synthetic SKU. Use a bounded
      // synthetic id for this post contract; both salvage and restored builders execute it.
      sku: Number(reference.externalKey.slice(4)) % 2_147_483_647,
      condition: "Sealed",
      variant: "Sealed",
      language: "English",
    })),
  };
  const unitKey = `tcgplayer:${domain}:sealed-product:source-observation-import`;
  const profile: CatalogProviderIntegrationProfileVersionRecord = catalogProviderIntegrationProfileVersions.find(
    (version) => version.active && catalogProviderProfileVersionIngestionUnitKey(version) === unitKey,
  )!;
  const payload = build({
    detail,
    externalReferenceRules: profile.profile.externalReferenceExtractionRules.rules,
    selectedOptionMapping: profile.profile.selectedOptionMapping,
  });
  const { sourceUrl, ...expected } = requireCatalogProviderSourceObservation({
    contract: requireSourceObservationMappingContract(profile),
    payload,
    observedAt: "2026-10-18T00:00:00.000Z",
  });
  return {
    unitKey,
    detail,
    expected: { ...expected, sourceUrlSha256: createHash("sha256").update(sourceUrl).digest("hex") },
  };
});
writeFileSync(
  new URL("tcgplayer-sealed-products.salvage.json", import.meta.url),
  JSON.stringify({ commit, path, cases }, null, 2) + "\n",
);
