import type { PgQueryable } from "@chase-sets/event-core-postgres";

export const sourceObservationIntegrationScopeSummaryTable = "catalog_source_observation_integration_scope_summaries";

export type SourceObservationIntegrationScopeKey = Readonly<{
  providerKey: string;
  languageCode: string;
  productLineId: string;
  seriesId: string;
  expansionId: string;
}>;

export type SourceObservationIntegrationScopeKeyRow = Readonly<{
  provider_key: string;
  language_code: string;
  product_line_id: string;
  series_id: string;
  expansion_id: string;
}>;

export function sourceObservationProductLineIdExpression(alias = ""): string {
  const prefix = alias ? `${alias}.` : "";
  return `coalesce(${prefix}source_payload->>'productLineId', ${prefix}source_payload->'detail'->>'productLineId', ${prefix}normalized->>'productLineId', ${prefix}normalized->'mergeIdentity'->>'productLineId')`;
}

export function sourceObservationProductLineNameExpression(alias = ""): string {
  const prefix = alias ? `${alias}.` : "";
  return `coalesce(${prefix}source_payload->>'productLineName', ${prefix}source_payload->'detail'->>'productLineName', ${prefix}normalized->>'productLineName', ${prefix}normalized->'mergeIdentity'->>'productLineName')`;
}

export function sourceObservationExpansionIdExpression(alias = ""): string {
  const prefix = alias ? `${alias}.` : "";
  return `coalesce(${prefix}normalized->>'expansionId', ${prefix}normalized->>'setId', ${prefix}normalized->>'setName', '')`;
}

export function sourceObservationExpansionNameExpression(alias = ""): string {
  const prefix = alias ? `${alias}.` : "";
  return `coalesce(${prefix}normalized->>'expansionName', ${prefix}normalized->>'setName', '')`;
}

export function sourceObservationSeriesIdExpression(alias = ""): string {
  const prefix = alias ? `${alias}.` : "";
  return `coalesce(${prefix}normalized->>'seriesId', '')`;
}

export function sourceObservationSeriesNameExpression(alias = ""): string {
  const prefix = alias ? `${alias}.` : "";
  return `coalesce(${prefix}normalized->>'seriesName', '')`;
}

export function sourceObservationIntegrationScopeSummarySelectSql(alias = ""): string {
  const prefix = alias ? `${alias}.` : "";
  return `${prefix}provider_key,
       ${prefix}language_code,
       coalesce(${sourceObservationProductLineIdExpression(alias)}, '') AS product_line_id,
       max(coalesce(${sourceObservationProductLineNameExpression(alias)}, '')) AS product_line_name,
       ${sourceObservationSeriesIdExpression(alias)} AS series_id,
       max(${sourceObservationSeriesNameExpression(alias)}) AS series_name,
       ${sourceObservationExpansionIdExpression(alias)} AS expansion_id,
       max(${sourceObservationExpansionNameExpression(alias)}) AS expansion_name`;
}

export async function readSourceObservationIntegrationScopeKey(
  db: PgQueryable,
  observationId: string,
): Promise<SourceObservationIntegrationScopeKey | null> {
  const result = await db.query<SourceObservationIntegrationScopeKeyRow>(
    `SELECT provider_key,
            language_code,
            coalesce(${sourceObservationProductLineIdExpression()}, '') AS product_line_id,
            ${sourceObservationSeriesIdExpression()} AS series_id,
            ${sourceObservationExpansionIdExpression()} AS expansion_id
     FROM catalog_source_observations
     WHERE observation_id = $1`,
    [observationId],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  return {
    providerKey: row.provider_key,
    languageCode: row.language_code,
    productLineId: row.product_line_id,
    seriesId: row.series_id,
    expansionId: row.expansion_id,
  };
}

export async function rebuildSourceObservationIntegrationScopeSummaries(
  db: PgQueryable,
  keys: readonly (SourceObservationIntegrationScopeKey | null)[],
  updatedAt: string,
): Promise<void> {
  const uniqueKeys = dedupeScopeKeys(keys);
  for (const key of uniqueKeys) {
    await rebuildSourceObservationIntegrationScopeSummary(db, key, updatedAt);
  }
}

async function rebuildSourceObservationIntegrationScopeSummary(
  db: PgQueryable,
  key: SourceObservationIntegrationScopeKey,
  updatedAt: string,
): Promise<void> {
  const keyValues = [key.providerKey, key.languageCode, key.productLineId, key.seriesId, key.expansionId] as const;

  await db.query(
    `DELETE FROM ${sourceObservationIntegrationScopeSummaryTable}
     WHERE provider_key = $1
       AND language_code = $2
       AND product_line_id = $3
       AND series_id = $4
       AND expansion_id = $5`,
    keyValues,
  );

  await db.query(
    `INSERT INTO ${sourceObservationIntegrationScopeSummaryTable} (
       provider_key,
       language_code,
       product_line_id,
       product_line_name,
       series_id,
       series_name,
       expansion_id,
       expansion_name,
       total_observations,
       observed_observations,
       changed_observations,
       promoted_observations,
       rejected_observations,
       first_observed_at,
       latest_observed_at,
       latest_source_updated_at,
       updated_at
     )
     SELECT
       provider_key,
       language_code,
       coalesce(${sourceObservationProductLineIdExpression()}, '') AS product_line_id,
       max(coalesce(${sourceObservationProductLineNameExpression()}, '')) AS product_line_name,
       ${sourceObservationSeriesIdExpression()} AS series_id,
       max(${sourceObservationSeriesNameExpression()}) AS series_name,
       ${sourceObservationExpansionIdExpression()} AS expansion_id,
       max(${sourceObservationExpansionNameExpression()}) AS expansion_name,
       COUNT(*)::integer AS total_observations,
       (COUNT(*) FILTER (WHERE status = 'observed'))::integer AS observed_observations,
       (COUNT(*) FILTER (WHERE status = 'changed'))::integer AS changed_observations,
       (COUNT(*) FILTER (WHERE status = 'promoted'))::integer AS promoted_observations,
       (COUNT(*) FILTER (WHERE status = 'rejected'))::integer AS rejected_observations,
       MIN(observed_at) AS first_observed_at,
       MAX(observed_at) AS latest_observed_at,
       MAX(source_updated_at) AS latest_source_updated_at,
       $6::timestamptz AS updated_at
     FROM catalog_source_observations
     WHERE provider_key = $1
       AND language_code = $2
       AND coalesce(${sourceObservationProductLineIdExpression()}, '') = $3
       AND ${sourceObservationSeriesIdExpression()} = $4
       AND ${sourceObservationExpansionIdExpression()} = $5
     GROUP BY
       provider_key,
       language_code,
       coalesce(${sourceObservationProductLineIdExpression()}, ''),
       ${sourceObservationSeriesIdExpression()},
       ${sourceObservationExpansionIdExpression()}
     ON CONFLICT (provider_key, language_code, product_line_id, series_id, expansion_id) DO UPDATE SET
       product_line_name = EXCLUDED.product_line_name,
       series_name = EXCLUDED.series_name,
       expansion_name = EXCLUDED.expansion_name,
       total_observations = EXCLUDED.total_observations,
       observed_observations = EXCLUDED.observed_observations,
       changed_observations = EXCLUDED.changed_observations,
       promoted_observations = EXCLUDED.promoted_observations,
       rejected_observations = EXCLUDED.rejected_observations,
       first_observed_at = EXCLUDED.first_observed_at,
       latest_observed_at = EXCLUDED.latest_observed_at,
       latest_source_updated_at = EXCLUDED.latest_source_updated_at,
       updated_at = EXCLUDED.updated_at`,
    [...keyValues, updatedAt],
  );
}

function dedupeScopeKeys(
  keys: readonly (SourceObservationIntegrationScopeKey | null)[],
): SourceObservationIntegrationScopeKey[] {
  const byKey = new Map<string, SourceObservationIntegrationScopeKey>();
  for (const key of keys) {
    if (!key) {
      continue;
    }
    byKey.set(
      [key.providerKey, key.languageCode, key.productLineId, key.seriesId, key.expansionId].join("\u0000"),
      key,
    );
  }
  return [...byKey.values()];
}
