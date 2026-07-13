import { createHash } from "node:crypto";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import type { JsonValue } from "@chase-sets/primitives/json";
import {
  decodeListingEvidencePolicyValue,
  evaluateListingEvidencePolicy,
  LISTING_EVIDENCE_POLICY_SCHEMA_VERSION,
  listingEvidencePolicyHash,
  marketplaceListingEvidencePolicy,
  type ListingEvidenceEvaluationFacts,
  type ListingEvidencePolicyDiagnostic,
  type ListingEvidencePolicyEvaluation,
  type ListingEvidencePolicyValue,
} from "../domain/policy";

type PolicyDocument = NonNullable<Awaited<ReturnType<PolicyRuntime["getPolicyDocument"]>>>;

export type ListingEvidencePolicySelectorOption = Readonly<{
  id: string;
  label: string;
  parentId?: string | null;
}>;

export type ListingEvidencePolicySelectorCatalog = Readonly<{
  catalogItems: readonly ListingEvidencePolicySelectorOption[];
  products: readonly ListingEvidencePolicySelectorOption[];
  blueprints: readonly ListingEvidencePolicySelectorOption[];
  categories: readonly ListingEvidencePolicySelectorOption[];
  dimensions: readonly ListingEvidencePolicySelectorOption[];
  options: readonly ListingEvidencePolicySelectorOption[];
  gradedTraits: readonly ListingEvidencePolicySelectorOption[];
  sellerRiskLevels: readonly ListingEvidencePolicySelectorOption[];
}>;

export type ListingEvidencePolicySemanticDiff = Readonly<{
  addedRuleIds: readonly string[];
  removedRuleIds: readonly string[];
  changedRuleIds: readonly string[];
}>;

export type ListingEvidencePolicyImpactPreview = Readonly<{
  impactedListingCount: number;
  sample: readonly Readonly<{
    listingId: string;
    beforeMatchedRuleIds: readonly string[];
    afterMatchedRuleIds: readonly string[];
  }>[];
  previewHash: string;
}>;

export type ListingEvidencePolicyValidation = Readonly<{
  valid: boolean;
  diagnostics: readonly ListingEvidencePolicyDiagnostic[];
  policyHash: string;
  semanticDiff: ListingEvidencePolicySemanticDiff;
  impactPreview: ListingEvidencePolicyImpactPreview;
}>;

export type ListingEvidencePolicyOverview = Readonly<{
  policyKey: string;
  current: Readonly<{
    policyId: string | null;
    version: number | null;
    hash: string;
    lifecycle: string;
    effectiveFrom: string | null;
    effectiveUntil: string | null;
    value: ListingEvidencePolicyValue;
  }>;
  documents: readonly Readonly<{
    policyId: string;
    version: number;
    lifecycle: string;
    status: string;
    hash: string;
    effectiveFrom: string;
    effectiveUntil: string | null;
    updatedAt: string;
  }>[];
}>;

export type ListingEvidencePolicyRuntime = ReturnType<typeof createListingEvidencePolicyRuntime>;

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function contentHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

function documentVersion(document: PolicyDocument): number {
  return document.history?.length ?? 1;
}

function policyFromDocument(document: PolicyDocument): ListingEvidencePolicyValue {
  return decodeListingEvidencePolicyValue(document.value as JsonValue);
}

async function listPolicyDocuments(db: PgQueryable) {
  const result = await db.query<{
    document_id: string;
    status: string;
    value: unknown;
    effective_from: string;
    effective_until: string | null;
    updated_at: string;
    version: string | number;
  }>(
    `SELECT document.document_id,
            document.status,
            document.value,
            document.effective_from::text,
            document.effective_until::text,
            document.updated_at::text,
            COUNT(history.history_id) AS version
       FROM platform_policy_documents document
       LEFT JOIN platform_policy_document_history history
         ON history.document_id = document.document_id
      WHERE document.policy_key = $1
      GROUP BY document.document_id
      ORDER BY document.effective_from DESC, document.updated_at DESC, document.document_id DESC`,
    [marketplaceListingEvidencePolicy.policyKey],
  );
  return result.rows;
}

async function loadSelectorCatalog(db: PgQueryable): Promise<ListingEvidencePolicySelectorCatalog> {
  const [items, products, blueprints, categories, dimensions, options] = await Promise.all([
    db.query<{ id: string; label: string }>(
      `SELECT catalog_item_id AS id, title AS label FROM marketplace_catalog_items ORDER BY title, catalog_item_id`,
    ),
    db.query<{ id: string; label: string }>(
      `SELECT DISTINCT product_id AS id, product_id AS label FROM marketplace_supply_items ORDER BY product_id`,
    ),
    db.query<{ id: string; label: string }>(
      `SELECT blueprint_id AS id, name AS label FROM marketplace_catalog_blueprints ORDER BY name, blueprint_id`,
    ),
    db.query<{ id: string; label: string }>(
      `SELECT category_id AS id, name AS label FROM marketplace_catalog_categories ORDER BY name, category_id`,
    ),
    db.query<{ id: string; label: string }>(
      `SELECT dimension_id AS id, name AS label FROM marketplace_catalog_dimensions ORDER BY name, dimension_id`,
    ),
    db.query<{ id: string; label: string; parent_id: string }>(
      `SELECT option_id AS id, COALESCE(NULLIF(label, ''), code, option_id) AS label, dimension_id AS parent_id
         FROM marketplace_catalog_dimension_options
        ORDER BY dimension_id, label, option_id`,
    ),
  ]);
  return {
    catalogItems: items.rows,
    products: products.rows,
    blueprints: blueprints.rows,
    categories: categories.rows,
    dimensions: dimensions.rows,
    options: options.rows.map((row) => ({ id: row.id, label: row.label, parentId: row.parent_id })),
    gradedTraits: [{ id: "graded-item", label: "Graded item present" }],
    sellerRiskLevels: ["low", "medium", "high"].map((id) => ({
      id,
      label: `${id[0]!.toUpperCase()}${id.slice(1)} risk`,
    })),
  };
}

async function existingIds(db: PgQueryable, sql: string, values: readonly string[]): Promise<Set<string>> {
  if (values.length === 0) return new Set();
  const result = await db.query<{ id: string }>(sql, [[...new Set(values)]]);
  return new Set(result.rows.map((row) => row.id));
}

async function validateReferences(db: PgQueryable, value: ListingEvidencePolicyValue) {
  const itemIds = value.rules.flatMap((rule) => rule.selector.catalogItemIds);
  const productIds = value.rules.flatMap((rule) => rule.selector.productIds);
  const blueprintIds = value.rules.flatMap((rule) => rule.selector.blueprintIds);
  const categoryIds = value.rules.flatMap((rule) => rule.selector.categoryIds);
  const optionIds = value.rules.flatMap((rule) => rule.selector.options.map((option) => option.optionId));
  const dimensionIds = value.rules.flatMap((rule) => rule.selector.options.map((option) => option.dimensionId));
  const [items, products, blueprints, categories, options, dimensions] = await Promise.all([
    existingIds(
      db,
      "SELECT catalog_item_id AS id FROM marketplace_catalog_items WHERE catalog_item_id = ANY($1::text[])",
      itemIds,
    ),
    existingIds(
      db,
      "SELECT DISTINCT product_id AS id FROM marketplace_supply_items WHERE product_id = ANY($1::text[])",
      productIds,
    ),
    existingIds(
      db,
      "SELECT blueprint_id AS id FROM marketplace_catalog_blueprints WHERE blueprint_id = ANY($1::text[])",
      blueprintIds,
    ),
    existingIds(
      db,
      "SELECT category_id AS id FROM marketplace_catalog_categories WHERE category_id = ANY($1::text[])",
      categoryIds,
    ),
    existingIds(
      db,
      "SELECT option_id AS id FROM marketplace_catalog_dimension_options WHERE option_id = ANY($1::text[])",
      optionIds,
    ),
    existingIds(
      db,
      "SELECT dimension_id AS id FROM marketplace_catalog_dimensions WHERE dimension_id = ANY($1::text[])",
      dimensionIds,
    ),
  ]);
  const diagnostics: ListingEvidencePolicyDiagnostic[] = [];
  const addMissing = (kind: string, ids: readonly string[], found: Set<string>) => {
    for (const id of new Set(ids)) {
      if (!found.has(id))
        diagnostics.push({
          code: "invalid_reference",
          path: kind,
          message: `${kind} reference '${id}' does not exist in Marketplace's projected stable Catalog facts.`,
        });
    }
  };
  addMissing("catalogItemIds", itemIds, items);
  addMissing("productIds", productIds, products);
  addMissing("blueprintIds", blueprintIds, blueprints);
  addMissing("categoryIds", categoryIds, categories);
  addMissing("optionIds", optionIds, options);
  addMissing("dimensionIds", dimensionIds, dimensions);
  return diagnostics;
}

function semanticDiff(
  before: ListingEvidencePolicyValue,
  after: ListingEvidencePolicyValue,
): ListingEvidencePolicySemanticDiff {
  const beforeRules = new Map(before.rules.map((rule) => [rule.ruleId, contentHash(rule)]));
  const afterRules = new Map(after.rules.map((rule) => [rule.ruleId, contentHash(rule)]));
  return {
    addedRuleIds: [...afterRules.keys()].filter((id) => !beforeRules.has(id)).sort(),
    removedRuleIds: [...beforeRules.keys()].filter((id) => !afterRules.has(id)).sort(),
    changedRuleIds: [...afterRules.keys()]
      .filter((id) => beforeRules.has(id) && beforeRules.get(id) !== afterRules.get(id))
      .sort(),
  };
}

type ListingFactRow = Readonly<{
  listing_id: string;
  catalog_item_id: string;
  product_id: string;
  blueprint_id: string | null;
  category_ids: unknown;
  selected_options: unknown;
  graded_card: unknown;
  price_amount: string;
  review_count_as_seller: number | null;
  badges: unknown;
}>;

function asStringList(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function factsFromRow(row: ListingFactRow): ListingEvidenceEvaluationFacts {
  const options = Array.isArray(row.selected_options)
    ? row.selected_options.flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const record = entry as Record<string, unknown>;
        return typeof record.dimensionId === "string" && typeof record.optionId === "string"
          ? [{ dimensionId: record.dimensionId, optionId: record.optionId }]
          : [];
      })
    : [];
  return {
    catalogItemId: row.catalog_item_id,
    productId: row.product_id,
    blueprintId: row.blueprint_id,
    categoryIds: asStringList(row.category_ids),
    selectedOptions: options,
    gradedItem: row.graded_card !== null,
    priceAmount: row.price_amount,
    seller: {
      reviewCount: Number(row.review_count_as_seller ?? 0),
      badgeKeys: asStringList(row.badges),
      riskLevel: null,
    },
  };
}

function evaluationSignature(evaluation: ListingEvidencePolicyEvaluation) {
  return contentHash({ matchedRuleIds: evaluation.matchedRuleIds, requirements: evaluation.requirements });
}

async function impactPreview(
  db: PgQueryable,
  before: ListingEvidencePolicyValue,
  after: ListingEvidencePolicyValue,
): Promise<ListingEvidencePolicyImpactPreview> {
  let afterListingId = "";
  let impactedListingCount = 0;
  const sample: ListingEvidencePolicyImpactPreview["sample"][number][] = [];
  for (;;) {
    const page = await db.query<ListingFactRow>(
      `SELECT listing.listing_id,
              listing.catalog_item_id,
              listing.product_id,
              catalog_item.blueprint_id,
              catalog_item.category_ids,
              listing.selected_options,
              listing.graded_card,
              listing.price_amount::text,
              account.review_count_as_seller,
              account.badges
         FROM marketplace_listing_pages listing
         LEFT JOIN marketplace_catalog_items catalog_item ON catalog_item.catalog_item_id = listing.catalog_item_id
         LEFT JOIN marketplace_account_pages account ON account.account_id = listing.account_id
        WHERE listing.listing_id > $1
        ORDER BY listing.listing_id
        LIMIT 500`,
      [afterListingId],
    );
    if (page.rows.length === 0) break;
    for (const row of page.rows) {
      const facts = factsFromRow(row);
      const metadata = { policyId: null, policyVersion: null, effectiveFrom: null, effectiveUntil: null };
      const beforeEvaluation = evaluateListingEvidencePolicy(before, facts, metadata);
      const afterEvaluation = evaluateListingEvidencePolicy(after, facts, metadata);
      if (evaluationSignature(beforeEvaluation) !== evaluationSignature(afterEvaluation)) {
        impactedListingCount += 1;
        if (sample.length < 20) {
          sample.push({
            listingId: row.listing_id,
            beforeMatchedRuleIds: beforeEvaluation.matchedRuleIds,
            afterMatchedRuleIds: afterEvaluation.matchedRuleIds,
          });
        }
      }
    }
    afterListingId = page.rows.at(-1)!.listing_id;
  }
  return {
    impactedListingCount,
    sample,
    previewHash: contentHash({ impactedListingCount, sample, candidatePolicyHash: listingEvidencePolicyHash(after) }),
  };
}

export function createListingEvidencePolicyRuntime(
  deps: Readonly<{ db: PgQueryable; policies: PolicyRuntime; now?: () => Date }>,
) {
  const now = deps.now ?? (() => new Date());

  async function getDocument(documentId: string) {
    const document = await deps.policies.getPolicyDocument(documentId);
    if (!document || document.policy_key !== marketplaceListingEvidencePolicy.policyKey) {
      throw new Error("Listing Evidence Policy document was not found.");
    }
    return document;
  }

  async function validateValue(value: ListingEvidencePolicyValue): Promise<ListingEvidencePolicyValidation> {
    const resolved = await deps.policies.resolvePolicy(marketplaceListingEvidencePolicy);
    const diagnostics = await validateReferences(deps.db, value);
    const impact = await impactPreview(deps.db, resolved.value, value);
    return {
      valid: diagnostics.length === 0,
      diagnostics,
      policyHash: listingEvidencePolicyHash(value),
      semanticDiff: semanticDiff(resolved.value, value),
      impactPreview: impact,
    };
  }

  async function assertNoOtherActiveOverlap(
    effectiveFrom: string,
    effectiveUntil: string | null,
    excludedDocumentId: string | null,
  ) {
    const overlap = await deps.db.query<{ document_id: string }>(
      `SELECT document_id
         FROM platform_policy_documents
        WHERE policy_key = $1
          AND status = 'active'
          AND ($4::text IS NULL OR document_id <> $4)
          AND effective_from < COALESCE($3::timestamptz, 'infinity'::timestamptz)
          AND COALESCE(effective_until, 'infinity'::timestamptz) > $2::timestamptz
        ORDER BY effective_from, document_id
        LIMIT 1`,
      [marketplaceListingEvidencePolicy.policyKey, effectiveFrom, effectiveUntil, excludedDocumentId],
    );
    if (overlap.rows[0]) {
      throw new Error(
        `Listing Evidence Policy version '${overlap.rows[0].document_id}' already covers part of that effective interval.`,
      );
    }
  }

  async function createDraft(
    input: Readonly<{
      policyName: string;
      rules: ListingEvidencePolicyValue["rules"];
      actorUserId: string;
      sourcePolicyDocumentId?: string | null;
    }>,
    context: EventStoreContext,
  ) {
    const value = decodeListingEvidencePolicyValue({
      schemaVersion: LISTING_EVIDENCE_POLICY_SCHEMA_VERSION,
      policyName: input.policyName,
      lifecycle: "draft",
      sourcePolicyDocumentId: input.sourcePolicyDocumentId ?? null,
      validation: null,
      rules: input.rules,
    } as JsonValue);
    return deps.policies.createPolicyDocument(
      marketplaceListingEvidencePolicy,
      {
        value,
        status: "inactive",
        effectiveFrom: now().toISOString(),
        effectiveUntil: null,
        actorUserId: input.actorUserId,
      },
      context,
    );
  }

  return {
    loadSelectorCatalog: () => loadSelectorCatalog(deps.db),
    async getOverview(): Promise<ListingEvidencePolicyOverview> {
      const resolved = await deps.policies.resolvePolicy(marketplaceListingEvidencePolicy);
      const currentDocument = resolved.documentId ? await deps.policies.getPolicyDocument(resolved.documentId) : null;
      const documents = await listPolicyDocuments(deps.db);
      return {
        policyKey: marketplaceListingEvidencePolicy.policyKey,
        current: {
          policyId: resolved.documentId,
          version: currentDocument ? documentVersion(currentDocument) : null,
          hash: listingEvidencePolicyHash(resolved.value),
          lifecycle: resolved.value.lifecycle,
          effectiveFrom: resolved.effectiveFrom,
          effectiveUntil: resolved.effectiveUntil,
          value: resolved.value,
        },
        documents: documents.map((document) => {
          const value = decodeListingEvidencePolicyValue(document.value as JsonValue);
          const nowMs = now().getTime();
          const lifecycle =
            document.status === "active" && Date.parse(document.effective_from) > nowMs
              ? "scheduled"
              : document.status === "active" &&
                  document.effective_until &&
                  Date.parse(document.effective_until) <= nowMs
                ? "superseded"
                : value.lifecycle;
          return {
            policyId: document.document_id,
            version: Number(document.version),
            lifecycle,
            status: document.status,
            hash: listingEvidencePolicyHash(value),
            effectiveFrom: document.effective_from,
            effectiveUntil: document.effective_until,
            updatedAt: document.updated_at,
          };
        }),
      };
    },
    createDraft,
    async validateDraft(documentId: string, actorUserId: string, context: EventStoreContext) {
      const document = await getDocument(documentId);
      const draft = policyFromDocument(document);
      if (document.status !== "inactive" || !["draft", "validated"].includes(draft.lifecycle)) {
        throw new Error("Only an inactive Listing Evidence Policy draft can be validated.");
      }
      const validation = await validateValue(draft);
      if (!validation.valid) return { documentId, version: documentVersion(document), ...validation };
      const validatedAt = now().toISOString();
      const value: ListingEvidencePolicyValue = {
        ...draft,
        lifecycle: "validated",
        validation: {
          validatedAt,
          policyHash: validation.policyHash,
          impactPreviewHash: validation.impactPreview.previewHash,
        },
      };
      const result = await deps.policies.revisePolicyDocument(
        marketplaceListingEvidencePolicy,
        documentId,
        {
          value,
          status: "inactive",
          effectiveFrom: document.effective_from,
          effectiveUntil: null,
          actorUserId,
        },
        context,
      );
      return { documentId, version: result.version, ...validation };
    },
    async rejectDraft(documentId: string, actorUserId: string, context: EventStoreContext) {
      const document = await getDocument(documentId);
      const draft = policyFromDocument(document);
      if (document.status !== "inactive" || !["draft", "validated"].includes(draft.lifecycle))
        throw new Error("Only a draft or validated policy version can be rejected.");
      const result = await deps.policies.revisePolicyDocument(
        marketplaceListingEvidencePolicy,
        documentId,
        {
          value: { ...draft, lifecycle: "rejected", validation: null },
          status: "inactive",
          effectiveFrom: document.effective_from,
          effectiveUntil: null,
          actorUserId,
        },
        context,
      );
      return { documentId, version: result.version };
    },
    async createRollbackDraft(sourceDocumentId: string, actorUserId: string, context: EventStoreContext) {
      const source = await getDocument(sourceDocumentId);
      const sourceValue = policyFromDocument(source);
      if (source.status !== "active" || sourceValue.lifecycle !== "active") {
        throw new Error("Rollback drafts can only be created from a retained active policy version.");
      }
      return createDraft(
        {
          policyName: `Rollback to ${sourceValue.policyName}`,
          rules: sourceValue.rules,
          actorUserId,
          sourcePolicyDocumentId: sourceDocumentId,
        },
        context,
      );
    },
    async activateDraft(
      documentId: string,
      input: Readonly<{
        effectiveFrom: string;
        effectiveUntil: string | null;
        impactAcknowledgmentHash: string;
        actorUserId: string;
      }>,
      context: EventStoreContext,
    ) {
      if (!input.effectiveFrom || Number.isNaN(Date.parse(input.effectiveFrom)))
        throw new Error("An explicit effective time is required before activation.");
      const document = await getDocument(documentId);
      const draft = policyFromDocument(document);
      if (document.status !== "inactive" || draft.lifecycle !== "validated" || !draft.validation) {
        throw new Error("The Listing Evidence Policy draft must be validated before activation.");
      }
      if (draft.validation.policyHash !== listingEvidencePolicyHash(draft))
        throw new Error("The draft changed after validation; validate it again.");
      if (input.impactAcknowledgmentHash !== draft.validation.impactPreviewHash) {
        throw new Error("Activation requires acknowledgment of the current Policy Impact Preview.");
      }
      const resolved = await deps.policies.resolvePolicy(marketplaceListingEvidencePolicy, { at: now().toISOString() });
      await assertNoOtherActiveOverlap(
        input.effectiveFrom,
        input.effectiveUntil,
        resolved.source === "policy" ? resolved.documentId : null,
      );
      if (resolved.source === "policy" && resolved.documentId && resolved.effectiveFrom) {
        await deps.policies.revisePolicyDocument(
          marketplaceListingEvidencePolicy,
          resolved.documentId,
          {
            value: resolved.value,
            status: "active",
            effectiveFrom: resolved.effectiveFrom,
            effectiveUntil: input.effectiveFrom,
            actorUserId: input.actorUserId,
          },
          context,
        );
      }
      const activeValue: ListingEvidencePolicyValue = {
        ...draft,
        lifecycle: "active",
        sourcePolicyDocumentId: documentId,
      };
      const created = await deps.policies.createPolicyDocument(
        marketplaceListingEvidencePolicy,
        {
          value: activeValue,
          status: "active",
          effectiveFrom: input.effectiveFrom,
          effectiveUntil: input.effectiveUntil,
          actorUserId: input.actorUserId,
        },
        context,
      );
      await deps.policies.revisePolicyDocument(
        marketplaceListingEvidencePolicy,
        documentId,
        {
          value: { ...draft, lifecycle: "superseded" },
          status: "inactive",
          effectiveFrom: document.effective_from,
          effectiveUntil: null,
          actorUserId: input.actorUserId,
        },
        context,
      );
      return {
        policyId: created.documentId,
        version: created.version,
        policyHash: listingEvidencePolicyHash(activeValue),
        scheduled: Date.parse(input.effectiveFrom) > now().getTime(),
      };
    },
    async evaluate(facts: ListingEvidenceEvaluationFacts, at?: string) {
      const resolved = await deps.policies.resolvePolicy(marketplaceListingEvidencePolicy, at ? { at } : undefined);
      const document = resolved.documentId ? await deps.policies.getPolicyDocument(resolved.documentId) : null;
      return evaluateListingEvidencePolicy(resolved.value, facts, {
        policyId: resolved.documentId,
        policyVersion: document ? documentVersion(document) : null,
        effectiveFrom: resolved.effectiveFrom,
        effectiveUntil: resolved.effectiveUntil,
      });
    },
  };
}
