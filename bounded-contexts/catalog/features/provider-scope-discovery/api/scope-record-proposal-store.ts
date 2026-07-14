import { createHash } from "node:crypto";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { JsonObject } from "@chase-sets/primitives/json";
import type { CatalogScopeProductDomain, CatalogScopeRecordKind } from "../../scope-registry/domain/contract";

export type CanonicalScopeRecordProposalReviewStatus = "proposed" | "accepted" | "rejected";

export type CanonicalScopeRecordProposalInput = Readonly<{
  productDomain: CatalogScopeProductDomain;
  scopeKind: CatalogScopeRecordKind;
  name: string;
  officialSetCode: string | null;
  releaseDate: string | null;
  languageEditions: readonly string[];
  parentExternalIds: readonly string[];
  evidence: JsonObject;
}>;

export type CanonicalScopeRecordProposalRecord = CanonicalScopeRecordProposalInput &
  Readonly<{
    proposalId: string;
    scopeRecordId: string;
    normalizedName: string;
    reviewStatus: CanonicalScopeRecordProposalReviewStatus;
    firstProposedAt: string;
    updatedAt: string;
  }>;

type ProposalRow = Readonly<{
  proposal_id: string;
  scope_record_id: string;
  product_domain: CatalogScopeProductDomain;
  scope_kind: CatalogScopeRecordKind;
  name: string;
  normalized_name: string;
  official_set_code: string | null;
  release_date: string | Date | null;
  language_editions: readonly string[];
  parent_external_ids: readonly string[];
  review_status: CanonicalScopeRecordProposalReviewStatus;
  evidence: JsonObject;
  first_proposed_at: string | Date;
  updated_at: string | Date;
}>;

export async function proposeCanonicalScopeRecord(
  db: PgQueryable,
  input: CanonicalScopeRecordProposalInput,
): Promise<CanonicalScopeRecordProposalRecord> {
  const normalized = normalizeProposal(input);
  const proposalId = computeCanonicalScopeRecordProposalId(normalized);
  const scopeRecordId = `proposed-scope-${proposalId}`;
  const result = await db.query<ProposalRow>(
    `INSERT INTO catalog_scope_record_proposals (
       proposal_id, scope_record_id, product_domain, scope_kind, name, normalized_name,
       official_set_code, release_date, language_editions, parent_external_ids,
       review_status, evidence, first_proposed_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date, $9::jsonb, $10::jsonb, 'proposed', $11::jsonb, now(), now())
     ON CONFLICT (proposal_id) DO UPDATE SET
       evidence = CASE
         WHEN catalog_scope_record_proposals.review_status = 'proposed'
           THEN catalog_scope_record_proposals.evidence || EXCLUDED.evidence
         ELSE catalog_scope_record_proposals.evidence
       END,
       updated_at = CASE
         WHEN catalog_scope_record_proposals.review_status = 'proposed' THEN now()
         ELSE catalog_scope_record_proposals.updated_at
       END
     RETURNING *`,
    [
      proposalId,
      scopeRecordId,
      normalized.productDomain,
      normalized.scopeKind,
      normalized.name,
      normalizeScopeMatchKey(normalized.name),
      normalized.officialSetCode,
      normalized.releaseDate,
      JSON.stringify(normalized.languageEditions),
      JSON.stringify(normalized.parentExternalIds),
      JSON.stringify(normalized.evidence),
    ],
  );
  return toProposalRecord(result.rows[0]!);
}

export async function listCanonicalScopeRecordProposals(
  db: PgQueryable,
  input: Readonly<{
    reviewStatus?: CanonicalScopeRecordProposalReviewStatus | null;
    productDomain?: CatalogScopeProductDomain | null;
    limit?: number;
  }> = {},
): Promise<readonly CanonicalScopeRecordProposalRecord[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (input.reviewStatus) {
    params.push(input.reviewStatus);
    conditions.push(`review_status = $${params.length}`);
  }
  if (input.productDomain) {
    params.push(input.productDomain);
    conditions.push(`product_domain = $${params.length}`);
  }
  params.push(Math.min(Math.max(input.limit ?? 500, 1), 2_000));

  const result = await db.query<ProposalRow>(
    `SELECT *
     FROM catalog_scope_record_proposals
     ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""}
     ORDER BY first_proposed_at DESC, proposal_id ASC
     LIMIT $${params.length}`,
    params,
  );
  return result.rows.map(toProposalRecord);
}

export function computeCanonicalScopeRecordProposalId(
  input: Pick<CanonicalScopeRecordProposalInput, "productDomain" | "scopeKind" | "name" | "officialSetCode">,
): string {
  const identity = {
    productDomain: input.productDomain,
    scopeKind: input.scopeKind,
    identityKey: input.officialSetCode
      ? `code:${normalizeScopeIdentifierKey(input.officialSetCode)}`
      : `name:${normalizeScopeMatchKey(input.name)}`,
  };
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

export function normalizeScopeIdentifierKey(value: string): string {
  return normalizeScopeMatchKey(value).replace(/[^a-z0-9]/g, "");
}

export function normalizeScopeMatchKey(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeProposal(input: CanonicalScopeRecordProposalInput): CanonicalScopeRecordProposalInput {
  return {
    ...input,
    name: input.name.trim(),
    officialSetCode: input.officialSetCode?.trim() || null,
    releaseDate: validIsoDate(input.releaseDate),
    languageEditions: normalizedList(input.languageEditions.map((language) => language.toLowerCase())),
    parentExternalIds: normalizedList(input.parentExternalIds),
  };
}

function normalizedList(values: readonly string[]): readonly string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort((left, right) =>
    left.localeCompare(right),
  );
}

function validIsoDate(value: string | null): string | null {
  const normalized = value?.trim() ?? "";
  return normalized && !Number.isNaN(Date.parse(normalized)) ? normalized.slice(0, 10) : null;
}

function toProposalRecord(row: ProposalRow): CanonicalScopeRecordProposalRecord {
  return {
    proposalId: row.proposal_id,
    scopeRecordId: row.scope_record_id,
    productDomain: row.product_domain,
    scopeKind: row.scope_kind,
    name: row.name,
    normalizedName: row.normalized_name,
    officialSetCode: row.official_set_code,
    releaseDate: row.release_date === null ? null : toIsoDate(row.release_date).slice(0, 10),
    languageEditions: row.language_editions,
    parentExternalIds: row.parent_external_ids,
    reviewStatus: row.review_status,
    evidence: row.evidence,
    firstProposedAt: toIsoDate(row.first_proposed_at),
    updatedAt: toIsoDate(row.updated_at),
  };
}

function toIsoDate(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
