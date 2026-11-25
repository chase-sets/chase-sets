import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { isCatalogObservationRequest } from "../../../../operator-session/domain/extension/protocol";
import { tcgplayerSetNameUnits } from "../../../../operator-session/domain/extension/set-names/contract";
import type { CatalogSyncAcceptedScopeMapping } from "../catalog-sync-scope-planner";
import { tcgplayerExtensionSealedProductUnitKeys } from "./adapter";

export function sealedRequestProductLine(unitKey: string): number | null {
  if (!tcgplayerExtensionSealedProductUnitKeys.some((key) => key === unitKey)) return null;
  return (
    tcgplayerSetNameUnits.find(({ unitKey: key }) => key === unitKey.replace(":sealed-product:", ":single-card:"))
      ?.productLineId ?? null
  );
}

export type SealedRequestCoordinates = Readonly<{ productLineId: number; setNameId: number; searchName: string }>;

export async function resolveSealedRequestCoordinates(
  db: PgQueryable,
  mapping: CatalogSyncAcceptedScopeMapping,
): Promise<SealedRequestCoordinates | null> {
  const { unitKey, productLineId, setName, setId, languageCode } = mapping;
  const line = sealedRequestProductLine(unitKey);
  if (
    line === null ||
    productLineId !== String(line) ||
    (languageCode && languageCode !== "en") ||
    !["accepted", "auto-accepted"].includes(mapping.reviewStatus) ||
    (!setName && !setId)
  )
    return null;
  const { rows } = await db.query<{ set_name_id: string; label: string }>(
    `SELECT metadata->>'setNameId' AS set_name_id, label
      FROM catalog_provider_scope_observations
     WHERE provider_key = 'tcgplayer' AND unit_key = $1 AND scope_kind IN ('set', 'expansion')
       AND source_query_kind = 'set-names' AND language_code = 'en'
       AND parents = jsonb_build_array($2::text) AND metadata->>'productLineId' = $2
       AND metadata->>'active' = 'true' AND metadata->>'grantId' IS NOT NULL
       AND metadata->>'cleanSetName' = external_id
       AND ($3::text IS NULL OR external_id = $3 OR label = $3)
       AND ($4::text IS NULL OR metadata->>'setNameId' = $4)
     LIMIT 2 FOR SHARE`,
    [unitKey, productLineId, setName ?? null, setId ?? null],
  );
  if (rows.length !== 1 || !/^[1-9]\d{0,9}$/.test(rows[0]!.set_name_id)) return null;
  const coordinates = { productLineId: line, setNameId: Number(rows[0]!.set_name_id), searchName: rows[0]!.label };
  return isCatalogObservationRequest({
    kind: "sealed-products",
    requestId: "coordinate-check",
    expiresAt: "2000-01-01T00:00:00.000Z",
    ...coordinates,
  })
    ? coordinates
    : null;
}
