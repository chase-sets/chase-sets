import type { JsonValue } from "@chase-sets/primitives/json";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  buildFilteredQuery,
  executeListQuery,
  type ListParams,
  type ListResult,
} from "../../../support/projection-support/list-query";
import type { SourceObservationNormalized } from "../domain/domain";

export type SourceObservationListRow = Readonly<{
  observation_id: string;
  provider_key: string;
  external_key: string;
  source_url: string;
  language_code: string;
  source_record_hash: string;
  source_updated_at: string | null;
  observed_at: string;
  normalized: SourceObservationNormalized;
  status: string;
  status_reason: string | null;
  promoted_catalog_item_id: string | null;
  promoted_at: string | null;
  updated_at: string;
}>;

export type SourceObservationDetailRow = SourceObservationListRow &
  Readonly<{
    source_payload: JsonValue;
  }>;

export async function listSourceObservations(
  db: PgQueryable,
  params: ListParams & { provider?: string; language?: string } = {},
): Promise<ListResult<SourceObservationListRow>> {
  const extraConditions: string[] = [];
  const extraValues: unknown[] = [];
  let paramIndex = 1;

  if (params.provider) {
    extraConditions.push(`provider_key = $${paramIndex}`);
    extraValues.push(params.provider);
    paramIndex++;
  }

  if (params.language) {
    extraConditions.push(`language_code = $${paramIndex}`);
    extraValues.push(params.language);
    paramIndex++;
  }

  const query = buildFilteredQuery(
    "catalog_source_observations",
    params,
    [
      "external_key",
      "source_url",
      "(normalized->>'name')",
      "(normalized->>'setName')",
    ],
    "observed_at DESC",
    extraConditions,
    extraValues,
  );

  return executeListQuery<SourceObservationListRow>(
    db,
    query.countSql,
    query.listSql,
    query.values,
  );
}

export async function getSourceObservationDetail(
  db: PgQueryable,
  observationId: string,
): Promise<SourceObservationDetailRow | null> {
  const result = await db.query<SourceObservationDetailRow>(
    `SELECT * FROM catalog_source_observations WHERE observation_id = $1`,
    [observationId],
  );

  return result.rows[0] ?? null;
}
