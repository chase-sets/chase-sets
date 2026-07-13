import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  evaluateListingEvidencePolicy,
  LISTING_EVIDENCE_LAUNCH_POLICY_VALUE,
  type ListingEvidenceEvaluationFacts,
  type ListingEvidencePolicyEvaluation,
} from "../../listing-evidence-policy/domain/policy";
import {
  createListingEvidenceRequirementSnapshot,
  type ListingEvidenceRequirementSnapshot,
} from "../domain/evidence-requirement-snapshot";

export type ListingEvidencePolicyEvaluator = Readonly<{
  evaluate(facts: ListingEvidenceEvaluationFacts, at?: string): Promise<ListingEvidencePolicyEvaluation>;
}>;

export type ResolveListingEvidenceRequirementsInput = Readonly<{
  accountId: string;
  catalogItemId: string;
  productId: string;
  selectedOptions: readonly Readonly<{ dimensionId: string; optionId: string }>[];
  gradedItem: boolean;
  priceAmount: string;
  evaluatedAt: string;
}>;

type ResolverDeps = Readonly<{
  db: PgQueryable;
  listingEvidencePolicyEvaluator?: ListingEvidencePolicyEvaluator;
}>;

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

async function evaluationFacts(
  deps: ResolverDeps,
  input: ResolveListingEvidenceRequirementsInput,
): Promise<ListingEvidenceEvaluationFacts> {
  const catalog = await deps.db.query<{ blueprint_id: string | null; category_ids: unknown }>(
    `SELECT blueprint_id, category_ids
       FROM marketplace_catalog_items
      WHERE catalog_item_id = $1`,
    [input.catalogItemId],
  );
  const account = await deps.db.query<{ review_count: number; badges: unknown }>(
    `SELECT review_count_as_seller AS review_count, badges
       FROM marketplace_account_pages
      WHERE account_id = $1`,
    [input.accountId],
  );

  return {
    catalogItemId: input.catalogItemId,
    productId: input.productId,
    blueprintId: catalog.rows[0]?.blueprint_id ?? null,
    categoryIds: stringList(catalog.rows[0]?.category_ids),
    selectedOptions: input.selectedOptions,
    gradedItem: input.gradedItem,
    priceAmount: input.priceAmount,
    seller: {
      reviewCount: Number(account.rows[0]?.review_count ?? 0),
      badgeKeys: stringList(account.rows[0]?.badges),
      riskLevel: null,
    },
  };
}

export async function resolveListingEvidenceRequirements(
  deps: ResolverDeps,
  input: ResolveListingEvidenceRequirementsInput,
): Promise<ListingEvidenceRequirementSnapshot> {
  const facts = deps.listingEvidencePolicyEvaluator
    ? await evaluationFacts(deps, input)
    : {
        catalogItemId: input.catalogItemId,
        productId: input.productId,
        blueprintId: null,
        categoryIds: [],
        selectedOptions: input.selectedOptions,
        gradedItem: input.gradedItem,
        priceAmount: input.priceAmount,
        seller: { reviewCount: 0, badgeKeys: [], riskLevel: null },
      };
  let evaluation: ListingEvidencePolicyEvaluation;

  if (deps.listingEvidencePolicyEvaluator) {
    evaluation = await deps.listingEvidencePolicyEvaluator.evaluate(facts, input.evaluatedAt);
  } else {
    evaluation = evaluateListingEvidencePolicy(LISTING_EVIDENCE_LAUNCH_POLICY_VALUE, facts, {
      policyId: null,
      policyVersion: null,
      effectiveFrom: null,
      effectiveUntil: null,
    });
  }

  return createListingEvidenceRequirementSnapshot(evaluation, input.evaluatedAt);
}
