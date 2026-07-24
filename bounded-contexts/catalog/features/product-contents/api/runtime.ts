import { createHash } from "node:crypto";
import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { withPgTransaction } from "@chase-sets/event-core-postgres";
import {
  createProjectionHandlerSet,
  resolveProjectionDb,
  type ProjectionHandlerSet,
} from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { toJsonValue, type JsonObject } from "@chase-sets/primitives/json";
import type { CatalogRuntimeDeps } from "../../../support/authoring-support/runtime-support";
import {
  assert,
  ensureUniqueBy,
  localizedTextMapFromEnglish,
  normalizeLocalizedTextMap,
  type LocalizedTextMap,
} from "../../../support/runtime-support/common";
import type { CatalogItemId } from "../../../ids";
import {
  listProductContentInclusionPolicies,
  listProductContentsForContainer,
  listProductContainersForContained,
  listProductContentTypes,
} from "../read-model/queries";

export type ProductContentSelectedOption = Readonly<{
  dimensionId: string;
  optionId: string;
}>;

export type ProductContentProvenance = JsonObject;

export type ProductContentResolutionStatus = "resolved" | "unresolved";

export type ProductContentTypeInput = Readonly<{
  contentTypeId: string;
  key: string;
  displayName: LocalizedTextMap;
  sortOrder?: number;
  discoverySearchWeight?: number | null;
}>;

export type ProductContentInclusionPolicyInput = Readonly<{
  inclusionPolicyId: string;
  key: string;
  displayName: LocalizedTextMap;
  sortOrder?: number;
}>;

export type ReplaceProductContentsInput = Readonly<{
  containerCatalogItemId: CatalogItemId;
  containerSelectedOptions?: readonly ProductContentSelectedOption[];
  lines: readonly ProductContentLineInput[];
}>;

export type ProductContentLineInput = Readonly<{
  containedCatalogItemId?: CatalogItemId | null;
  containedSelectedOptions?: readonly ProductContentSelectedOption[];
  quantity: number | null;
  contentTypeId: string;
  inclusionPolicyId?: string | null;
  provenance?: ProductContentProvenance;
}>;

export type ProductContentLineSnapshot = Readonly<{
  lineId: string;
  containerCatalogItemId: string;
  containerSelectedOptions: readonly ProductContentSelectedOption[] | null;
  containerProductId: string | null;
  containedCatalogItemId: string | null;
  containedSelectedOptions: readonly ProductContentSelectedOption[] | null;
  containedProductId: string | null;
  quantity: number | null;
  contentTypeId: string;
  contentTypeDisplayName: LocalizedTextMap;
  contentTypeDiscoverySearchWeight: number | null;
  inclusionPolicyId: string | null;
  inclusionPolicyDisplayName: LocalizedTextMap | null;
  provenance: ProductContentProvenance;
  resolutionStatus: ProductContentResolutionStatus;
  targetLifecycleStatus: string | null;
}>;

export type ProductContentsResolvedFact = Readonly<{
  containerCatalogItemId: string;
  containerSelectedOptions: readonly ProductContentSelectedOption[] | null;
  containerProductId: string | null;
  lines: readonly ProductContentLineSnapshot[];
  resolvedFactHash: string;
  resolverVersion: number;
  resolvedAt: string;
}>;

type CatalogProductRow = Readonly<{
  catalog_item_id: string;
  status: string;
  blueprint_id: string | null;
  dimension_rules: unknown;
  canonical_dimension_order: unknown;
}>;

type ProductSchema = Readonly<{
  canonicalDimensionOrder?: readonly string[];
  dimensions?: readonly Readonly<{
    dimensionId?: string;
    required?: boolean;
    allowedOptions?: readonly Readonly<{ optionId?: string }>[] | null;
    allowedOptionIds?: readonly string[] | null;
  }>[];
}>;

type ProductDimension = NonNullable<ProductSchema["dimensions"]>[number];

export type ProductContentServices = Readonly<{
  upsertContentType: (contentType: ProductContentTypeInput) => Promise<void>;
  upsertInclusionPolicy: (policy: ProductContentInclusionPolicyInput) => Promise<void>;
  replaceProductContents: (
    input: ReplaceProductContentsInput,
    context: EventStoreContext,
  ) => Promise<ProductContentsResolvedFact>;
  removeProductContents: (
    input: Pick<ReplaceProductContentsInput, "containerCatalogItemId" | "containerSelectedOptions">,
    context: EventStoreContext,
  ) => Promise<ProductContentsResolvedFact>;
  listProductContentTypes: () => ReturnType<typeof listProductContentTypes>;
  listProductContentInclusionPolicies: () => ReturnType<typeof listProductContentInclusionPolicies>;
  listProductContentsForContainer: (
    containerCatalogItemId: string,
  ) => ReturnType<typeof listProductContentsForContainer>;
  listProductContainersForContained: (
    containedCatalogItemId: string,
  ) => ReturnType<typeof listProductContainersForContained>;
  projectors: readonly ProjectionHandlerSet[];
}>;

const resolverVersion = 1;

export function createProductContentRuntime(deps: CatalogRuntimeDeps): ProductContentServices {
  return {
    upsertContentType: (contentType) => upsertContentType(deps.db, contentType),
    upsertInclusionPolicy: (policy) => upsertInclusionPolicy(deps.db, policy),
    replaceProductContents: (input, context) => replaceProductContents(deps, input, context),
    removeProductContents: (input, context) =>
      replaceProductContents(
        deps,
        {
          containerCatalogItemId: input.containerCatalogItemId,
          containerSelectedOptions: input.containerSelectedOptions,
          lines: [],
        },
        context,
        "catalog.product-contents.removed",
      ),
    listProductContentTypes: () => listProductContentTypes(deps.db),
    listProductContentInclusionPolicies: () => listProductContentInclusionPolicies(deps.db),
    listProductContentsForContainer: (containerCatalogItemId) =>
      listProductContentsForContainer(deps.db, containerCatalogItemId),
    listProductContainersForContained: (containedCatalogItemId) =>
      listProductContainersForContained(deps.db, containedCatalogItemId),
    projectors: [
      createProjectionHandlerSet({
        projectionName: "catalog-product-contents-projection",
        handlers: {
          "catalog.product-contents.resolved": async (event, context) => {
            await replaceResolvedProductContents(
              resolveProjectionDb(context, deps.db),
              event.data as ProductContentsResolvedFact,
              "ambient",
            );
          },
        },
      }),
    ],
  };
}

async function upsertContentType(db: PgQueryable, input: ProductContentTypeInput): Promise<void> {
  const contentTypeId = normalizeRequiredId(input.contentTypeId, "Product Content Type requires an id.");
  const key = normalizeRequiredKey(input.key, "Product Content Type requires a key.");
  const displayName = normalizeLocalizedTextMap(input.displayName, { requiredEnglish: true });
  const sortOrder = normalizeSortOrder(input.sortOrder);
  const discoverySearchWeight = input.discoverySearchWeight ?? null;
  assert(
    discoverySearchWeight === null || (Number.isFinite(discoverySearchWeight) && discoverySearchWeight >= 0),
    "Product Content Type search weight must be null or a non-negative number.",
  );

  await db.query(
    `INSERT INTO catalog_product_content_types (
       content_type_id,
       key,
       display_name,
       status,
       sort_order,
       discovery_search_weight,
       updated_at
     ) VALUES ($1, $2, $3, 'active', $4, $5, now())
     ON CONFLICT (content_type_id) DO UPDATE SET
       key = EXCLUDED.key,
       display_name = EXCLUDED.display_name,
       status = EXCLUDED.status,
       sort_order = EXCLUDED.sort_order,
       discovery_search_weight = EXCLUDED.discovery_search_weight,
       updated_at = EXCLUDED.updated_at`,
    [contentTypeId, key, JSON.stringify(displayName), sortOrder, discoverySearchWeight],
  );
}

async function upsertInclusionPolicy(db: PgQueryable, input: ProductContentInclusionPolicyInput): Promise<void> {
  const inclusionPolicyId = normalizeRequiredId(
    input.inclusionPolicyId,
    "Product Content Inclusion Policy requires an id.",
  );
  const key = normalizeRequiredKey(input.key, "Product Content Inclusion Policy requires a key.");
  const displayName = normalizeLocalizedTextMap(input.displayName, { requiredEnglish: true });
  const sortOrder = normalizeSortOrder(input.sortOrder);

  await db.query(
    `INSERT INTO catalog_product_content_inclusion_policies (
       inclusion_policy_id,
       key,
       display_name,
       status,
       sort_order,
       updated_at
     ) VALUES ($1, $2, $3, 'active', $4, now())
     ON CONFLICT (inclusion_policy_id) DO UPDATE SET
       key = EXCLUDED.key,
       display_name = EXCLUDED.display_name,
       status = EXCLUDED.status,
       sort_order = EXCLUDED.sort_order,
       updated_at = EXCLUDED.updated_at`,
    [inclusionPolicyId, key, JSON.stringify(displayName), sortOrder],
  );
}

async function replaceProductContents(
  deps: CatalogRuntimeDeps,
  input: ReplaceProductContentsInput,
  context: EventStoreContext,
  commandEventType = "catalog.product-contents.replaced",
): Promise<ProductContentsResolvedFact> {
  const fact = await buildResolvedFact(deps.db, input);
  const streamId = `catalog.product-contents-${fact.containerCatalogItemId}`;
  const existingEvents = await deps.eventStore.readStream({ streamId });
  const currentVersion = existingEvents.length;
  const lastResolved = [...existingEvents]
    .reverse()
    .find((event) => event.eventType === "catalog.product-contents.resolved");
  const retainedFact = lastResolved ? (lastResolved.payload as unknown as ProductContentsResolvedFact) : null;
  // Compare stable content only: resolvedAt/resolvedFactHash change on every
  // rebuild and stored payload key order differs from freshly built facts, so
  // a raw serialized comparison would append duplicate events on every
  // retained-state repeat run.
  if (retainedFact && productContentsContentIdentity(retainedFact) === productContentsContentIdentity(fact)) {
    await replaceResolvedProductContents(deps.db, retainedFact);
    return retainedFact;
  }

  await deps.eventStore.appendToStream({
    streamId,
    expectedVersion: currentVersion,
    context,
    events: [
      {
        eventType: commandEventType,
        payload: {
          containerCatalogItemId: fact.containerCatalogItemId,
          containerSelectedOptions: toJsonValue(fact.containerSelectedOptions),
          lineCount: fact.lines.length,
        } as JsonObject,
      },
      {
        eventType: "catalog.product-contents.resolved",
        payload: toJsonValue(fact) as JsonObject,
      },
    ],
  });

  await replaceResolvedProductContents(deps.db, fact);

  return fact;
}

async function buildResolvedFact(
  db: PgQueryable,
  input: ReplaceProductContentsInput,
): Promise<ProductContentsResolvedFact> {
  const containerCatalogItemId = normalizeRequiredId(
    input.containerCatalogItemId,
    "Product Contents require a container Catalog Item.",
  );
  const containerItem = await loadCatalogProductRow(db, containerCatalogItemId);
  assert(containerItem !== null, "Product Contents container Catalog Item was not found.");
  assert(containerItem.status !== "removed", "Product Contents container cannot be a removed draft.");

  const containerSelectedOptions = normalizeOptionalSelectedOptions(input.containerSelectedOptions);
  const containerProductId = deriveProductId(containerItem, containerSelectedOptions);
  const contentTypesById = new Map(
    (await listProductContentTypes(db))
      .filter((type) => type.status === "active")
      .map((type) => [type.content_type_id, type] as const),
  );
  const inclusionPoliciesById = new Map(
    (await listProductContentInclusionPolicies(db))
      .filter((policy) => policy.status === "active")
      .map((policy) => [policy.inclusion_policy_id, policy] as const),
  );

  const resolvedAt = new Date().toISOString();
  const lines = await Promise.all(
    input.lines.map(async (line) =>
      buildLineSnapshot(db, {
        line,
        containerCatalogItemId,
        containerSelectedOptions,
        containerProductId,
        contentTypesById,
        inclusionPoliciesById,
      }),
    ),
  );
  const sortedLines = [...lines].sort((left, right) => left.lineId.localeCompare(right.lineId));

  ensureUniqueBy(sortedLines, (line) => line.lineId, "Product Content Lines must be unique.");
  await assertAcyclicGraph(db, {
    containerCatalogItemId,
    containerProductId,
    lines: sortedLines,
  });

  const factWithoutHash = {
    containerCatalogItemId,
    containerSelectedOptions,
    containerProductId,
    lines: sortedLines,
    resolverVersion,
    resolvedAt,
  };
  const resolvedFactHash = stableHash(factWithoutHash);

  return {
    ...factWithoutHash,
    resolvedFactHash,
  };
}

async function buildLineSnapshot(
  db: PgQueryable,
  input: Readonly<{
    line: ProductContentLineInput;
    containerCatalogItemId: string;
    containerSelectedOptions: readonly ProductContentSelectedOption[] | null;
    containerProductId: string | null;
    contentTypesById: ReadonlyMap<string, { display_name: LocalizedTextMap; discovery_search_weight: number | null }>;
    inclusionPoliciesById: ReadonlyMap<string, { display_name: LocalizedTextMap }>;
  }>,
): Promise<ProductContentLineSnapshot> {
  const contentTypeId = normalizeRequiredId(input.line.contentTypeId, "Product Content Line requires a content type.");
  const contentType = input.contentTypesById.get(contentTypeId);
  assert(contentType !== undefined, "Product Content Line content type is not active.");
  const inclusionPolicyId = normalizeNullableId(input.line.inclusionPolicyId);
  const inclusionPolicy = inclusionPolicyId ? input.inclusionPoliciesById.get(inclusionPolicyId) : null;
  assert(
    inclusionPolicyId === null || inclusionPolicy !== undefined,
    "Product Content Line inclusion policy is not active.",
  );
  const quantity = normalizeQuantity(input.line.quantity);
  const containedCatalogItemId = normalizeNullableId(input.line.containedCatalogItemId);
  const containedSelectedOptions = normalizeOptionalSelectedOptions(input.line.containedSelectedOptions);
  const provenance = normalizeProvenance(input.line.provenance);

  let containedProductId: string | null = null;
  let targetLifecycleStatus: string | null = null;
  if (containedCatalogItemId) {
    const containedItem = await loadCatalogProductRow(db, containedCatalogItemId);
    assert(containedItem !== null, "Product Content Line contained Catalog Item was not found.");
    containedProductId = deriveProductId(containedItem, containedSelectedOptions);
    targetLifecycleStatus = containedItem.status;
  }

  const resolutionStatus: ProductContentResolutionStatus = containedCatalogItemId ? "resolved" : "unresolved";
  const identityPayload = {
    containerCatalogItemId: input.containerCatalogItemId,
    containerSelectedOptions: input.containerSelectedOptions,
    containedCatalogItemId,
    containedSelectedOptions,
    contentTypeId,
    inclusionPolicyId,
    provenance,
  };

  const lineSnapshot = {
    lineId: `pcl_${stableHash(identityPayload).slice(0, 24)}`,
    containerCatalogItemId: input.containerCatalogItemId,
    containerSelectedOptions: input.containerSelectedOptions,
    containerProductId: input.containerProductId,
    containedCatalogItemId,
    containedSelectedOptions,
    containedProductId,
    quantity,
    contentTypeId,
    contentTypeDisplayName: contentType.display_name,
    contentTypeDiscoverySearchWeight: contentType.discovery_search_weight,
    inclusionPolicyId,
    inclusionPolicyDisplayName: inclusionPolicy?.display_name ?? null,
    provenance,
    resolutionStatus,
    targetLifecycleStatus,
  };

  assertNoSelfLink(lineSnapshot);
  return lineSnapshot;
}

async function assertAcyclicGraph(
  db: PgQueryable,
  replacement: Readonly<{
    containerCatalogItemId: string;
    containerProductId: string | null;
    lines: readonly ProductContentLineSnapshot[];
  }>,
): Promise<void> {
  const edges = await listExistingEdges(
    db,
    productNodeKey(replacement.containerCatalogItemId, replacement.containerProductId),
  );
  for (const line of replacement.lines) {
    const to = line.containedCatalogItemId
      ? productNodeKey(line.containedCatalogItemId, line.containedProductId)
      : null;
    if (to) {
      edges.push([productNodeKey(line.containerCatalogItemId, line.containerProductId), to]);
    }
  }

  const outgoing = new Map<string, string[]>();
  for (const [from, to] of edges) {
    outgoing.set(from, [...(outgoing.get(from) ?? []), to]);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (node: string): boolean => {
    if (visiting.has(node)) {
      return true;
    }
    if (visited.has(node)) {
      return false;
    }
    visiting.add(node);
    for (const next of outgoing.get(node) ?? []) {
      if (visit(next)) {
        return true;
      }
    }
    visiting.delete(node);
    visited.add(node);
    return false;
  };

  assert(
    !visit(productNodeKey(replacement.containerCatalogItemId, replacement.containerProductId)),
    "Product Contents cannot create cycles.",
  );
}

async function listExistingEdges(db: PgQueryable, replacementContainerNode: string): Promise<Array<[string, string]>> {
  const result = await db.query<{
    container_catalog_item_id: string;
    container_product_id: string | null;
    contained_catalog_item_id: string | null;
    contained_product_id: string | null;
  }>(
    `SELECT container_catalog_item_id,
            container_product_id,
            contained_catalog_item_id,
            contained_product_id
     FROM catalog_resolved_product_contents
     WHERE contained_catalog_item_id IS NOT NULL`,
  );

  return result.rows.flatMap((row) => {
    const from = productNodeKey(row.container_catalog_item_id, row.container_product_id);
    const containedCatalogItemId = row.contained_catalog_item_id;
    if (!containedCatalogItemId || from === replacementContainerNode) {
      return [];
    }
    return [[from, productNodeKey(containedCatalogItemId, row.contained_product_id)] as [string, string]];
  });
}

type ProductContentsWriteMode = "transactional" | "ambient";

async function replaceResolvedProductContents(
  db: PgQueryable,
  fact: ProductContentsResolvedFact,
  mode: ProductContentsWriteMode = "transactional",
): Promise<void> {
  if (mode === "transactional" && isPgTransactionalPool(db)) {
    await withPgTransaction(db, (client) => replaceResolvedProductContentsRows(client, fact));
    return;
  }
  await replaceResolvedProductContentsRows(db, fact);
}

function isPgTransactionalPool(db: PgQueryable): db is PgTransactionalPool {
  const candidate = db as { connect?: unknown; idleCount?: unknown; release?: unknown; totalCount?: unknown };
  return (
    typeof candidate.connect === "function" &&
    typeof candidate.release !== "function" &&
    (typeof candidate.totalCount === "number" || typeof candidate.idleCount === "number")
  );
}

async function replaceResolvedProductContentsRows(db: PgQueryable, fact: ProductContentsResolvedFact): Promise<void> {
  await db.query(
    `DELETE FROM catalog_resolved_product_contents
     WHERE container_catalog_item_id = $1
       AND (
         (container_product_id IS NULL AND $2::text IS NULL)
         OR container_product_id = $2
       )`,
    [fact.containerCatalogItemId, fact.containerProductId],
  );

  for (const line of fact.lines) {
    await db.query(
      `INSERT INTO catalog_resolved_product_contents (
         line_id,
         container_catalog_item_id,
         container_selected_options,
         container_product_id,
         contained_catalog_item_id,
         contained_selected_options,
         contained_product_id,
         quantity,
         content_type_id,
         content_type_display_name,
         content_type_discovery_search_weight,
         inclusion_policy_id,
         inclusion_policy_display_name,
         provenance,
         resolution_status,
         target_lifecycle_status,
         resolved_fact_hash,
         resolver_version,
         resolved_at,
         updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, now())
       ON CONFLICT (line_id) DO UPDATE SET
         container_catalog_item_id = EXCLUDED.container_catalog_item_id,
         container_selected_options = EXCLUDED.container_selected_options,
         container_product_id = EXCLUDED.container_product_id,
         contained_catalog_item_id = EXCLUDED.contained_catalog_item_id,
         contained_selected_options = EXCLUDED.contained_selected_options,
         contained_product_id = EXCLUDED.contained_product_id,
         quantity = EXCLUDED.quantity,
         content_type_id = EXCLUDED.content_type_id,
         content_type_display_name = EXCLUDED.content_type_display_name,
         content_type_discovery_search_weight = EXCLUDED.content_type_discovery_search_weight,
         inclusion_policy_id = EXCLUDED.inclusion_policy_id,
         inclusion_policy_display_name = EXCLUDED.inclusion_policy_display_name,
         provenance = EXCLUDED.provenance,
         resolution_status = EXCLUDED.resolution_status,
         target_lifecycle_status = EXCLUDED.target_lifecycle_status,
         resolved_fact_hash = EXCLUDED.resolved_fact_hash,
         resolver_version = EXCLUDED.resolver_version,
         resolved_at = EXCLUDED.resolved_at,
         updated_at = EXCLUDED.updated_at`,
      [
        line.lineId,
        line.containerCatalogItemId,
        jsonOrNull(line.containerSelectedOptions),
        line.containerProductId,
        line.containedCatalogItemId,
        jsonOrNull(line.containedSelectedOptions),
        line.containedProductId,
        line.quantity,
        line.contentTypeId,
        JSON.stringify(line.contentTypeDisplayName ?? localizedTextMapFromEnglish(line.contentTypeId)),
        line.contentTypeDiscoverySearchWeight,
        line.inclusionPolicyId,
        line.inclusionPolicyDisplayName ? JSON.stringify(line.inclusionPolicyDisplayName) : null,
        JSON.stringify(line.provenance),
        line.resolutionStatus,
        line.targetLifecycleStatus,
        fact.resolvedFactHash,
        fact.resolverVersion,
        fact.resolvedAt,
      ],
    );
  }
}

async function loadCatalogProductRow(db: PgQueryable, catalogItemId: string): Promise<CatalogProductRow | null> {
  const result = await db.query<CatalogProductRow>(
    `SELECT item.catalog_item_id,
            item.status,
            item.blueprint_id,
            COALESCE(blueprint.dimension_rules, '[]'::jsonb) AS dimension_rules,
            COALESCE(blueprint.canonical_dimension_order, '[]'::jsonb) AS canonical_dimension_order
     FROM catalog_items AS item
     LEFT JOIN catalog_blueprints AS blueprint
       ON blueprint.blueprint_id = item.blueprint_id
     WHERE item.catalog_item_id = $1`,
    [catalogItemId],
  );
  return result.rows[0] ?? null;
}

function deriveProductId(
  item: CatalogProductRow,
  selectedOptions: readonly ProductContentSelectedOption[] | null,
): string | null {
  if (selectedOptions === null) {
    return null;
  }
  const schema = productSchemaFromCatalogProduct(item);
  const dimensions = (schema.dimensions ?? []).map((dimension) => ({
    dimensionId: String(dimension.dimensionId ?? ""),
    required: Boolean(dimension.required),
    optionIds: [
      ...(dimension.allowedOptions ?? []).map((option) => String(option.optionId ?? "")),
      ...(dimension.allowedOptionIds ?? []).map(String),
    ].filter((optionId) => optionId.length > 0),
  }));
  const order = (schema.canonicalDimensionOrder ?? dimensions.map((dimension) => dimension.dimensionId))
    .map(String)
    .filter((dimensionId) => dimensionId.length > 0);
  const selectedByDimension = new Map(selectedOptions.map((entry) => [entry.dimensionId, entry.optionId]));

  for (const selected of selectedOptions) {
    const dimension = dimensions.find((candidate) => candidate.dimensionId === selected.dimensionId);
    assert(dimension !== undefined, "Selected option dimension is not part of the Catalog Item product schema.");
    assert(dimension.optionIds.includes(selected.optionId), "Selected option is not allowed for the Catalog Item.");
  }
  for (const dimension of dimensions) {
    assert(
      !dimension.required || selectedByDimension.has(dimension.dimensionId),
      "Required selected option is missing.",
    );
  }

  if (order.length === 0) {
    assert(selectedOptions.length === 0, "Catalog Item without dimensions cannot accept selected options.");
    return `${item.catalog_item_id}::`;
  }

  return `${item.catalog_item_id}::${order
    .map((dimensionId) => `${dimensionId}:${selectedByDimension.get(dimensionId) ?? "-"}`)
    .join("|")}`;
}

function productSchemaFromCatalogProduct(item: CatalogProductRow): ProductSchema {
  return {
    canonicalDimensionOrder: Array.isArray(item.canonical_dimension_order)
      ? item.canonical_dimension_order.map(String)
      : [],
    dimensions: Array.isArray(item.dimension_rules)
      ? item.dimension_rules.map((dimension) =>
          typeof dimension === "object" && dimension !== null
            ? (dimension as ProductDimension)
            : ({} as ProductDimension),
        )
      : [],
  };
}

function assertNoSelfLink(line: ProductContentLineSnapshot): void {
  if (!line.containedCatalogItemId) {
    return;
  }
  assert(
    productNodeKey(line.containerCatalogItemId, line.containerProductId) !==
      productNodeKey(line.containedCatalogItemId, line.containedProductId),
    "Product Content Line cannot contain itself.",
  );
}

function productNodeKey(catalogItemId: string, productId: string | null): string {
  return `${catalogItemId}::${productId ?? "*"}`;
}

function normalizeRequiredId(value: string, message: string): string {
  const normalized = value.trim();
  assert(normalized.length > 0, message);
  return normalized;
}

function normalizeNullableId(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function normalizeRequiredKey(value: string, message: string): string {
  return normalizeRequiredId(value, message).toLowerCase();
}

function normalizeSortOrder(value: number | undefined): number {
  const normalized = value ?? 100;
  assert(Number.isInteger(normalized), "Sort order must be an integer.");
  return normalized;
}

function normalizeOptionalSelectedOptions(
  selectedOptions: readonly ProductContentSelectedOption[] | undefined,
): readonly ProductContentSelectedOption[] | null {
  if (selectedOptions === undefined) {
    return null;
  }
  const normalized = selectedOptions
    .map((entry) => ({
      dimensionId: entry.dimensionId.trim(),
      optionId: entry.optionId.trim(),
    }))
    .filter((entry) => entry.dimensionId.length > 0 && entry.optionId.length > 0)
    .sort((left, right) =>
      left.dimensionId === right.dimensionId
        ? left.optionId.localeCompare(right.optionId)
        : left.dimensionId.localeCompare(right.dimensionId),
    );
  ensureUniqueBy(
    normalized,
    (entry) => entry.dimensionId,
    "Product Contents selected options must be unique per dimension.",
  );
  return normalized;
}

function normalizeQuantity(value: number | null): number | null {
  if (value === null) {
    return null;
  }
  assert(Number.isInteger(value) && value > 0, "Product Content Line quantity must be a positive integer or null.");
  return value;
}

function normalizeProvenance(value: ProductContentProvenance | undefined): ProductContentProvenance {
  return Object.fromEntries(
    Object.entries(value ?? {})
      .map(([key, entry]) => [key.trim(), entry] as const)
      .filter(([key]) => key.length > 0)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function jsonOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

function productContentsContentIdentity(fact: ProductContentsResolvedFact): string {
  const { resolvedAt: _resolvedAt, resolvedFactHash: _resolvedFactHash, ...content } = fact;
  return stableHash(content);
}

function stableHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(sortJson(value)))
    .digest("hex");
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortJson(entry)]),
    );
  }
  return value;
}
