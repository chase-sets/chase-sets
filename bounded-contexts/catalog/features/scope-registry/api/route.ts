import { authenticationRequiredResponse, forbiddenResponse } from "@chase-sets/http/responses";
import { Hono, type Context } from "hono";
import { t } from "@chase-sets/localization";
import type { CatalogAuthoringEnv } from "../../../support/authoring-support/api";
import type { CatalogScopeRegistryRuntimeDeps } from "./runtime";
import type { createCatalogScopeRegistryRuntime } from "./runtime";
import type { CatalogScopeRecordListParams, CatalogScopeRecordRow } from "../read-model/queries";
import { catalogScopeProductDomains, catalogScopeRecordKinds } from "../domain/contract";
import type { CatalogLifecycleStatus } from "../../../support/runtime-support/common";

const catalogLifecycleStatuses = [
  "draft",
  "active",
  "deprecated",
  "archived",
] as const satisfies readonly CatalogLifecycleStatus[];

const SCOPE_LIST_DEFAULT_LIMIT = 50;
const SCOPE_LIST_MAX_LIMIT = 200;

// ---------------------------------------------------------------------------
// Catalog Scope Registry HTTP API
//
// The composition seam that makes canonical Scope Records reachable from the
// deployable. Read-only today: the Scope Detail page (and, later, the
// scope-first Catalog Home list) fetch one Scope Record by id to drive the
// journey for that scope, starting with the language-editions section. Every
// state change still flows through the owning feature's own aggregate
// (Catalog Alias for language-edition links); this route never accepts writes.
// ---------------------------------------------------------------------------

export type CatalogScopeRegistryRouteServices = Pick<
  ReturnType<typeof createCatalogScopeRegistryRuntime>,
  "getScopeRecord" | "listScopeRecords"
>;

/** The Scope Record shape the browser receives: camelCase, JSON-safe. */
export type CatalogScopeRecordDetail = Readonly<{
  scopeRecordId: string;
  productDomain: string;
  scopeKind: string;
  referenceTypeKey: string;
  referenceRecordId: string;
  referenceRecordKey: string;
  name: string;
  parentScopeRecordId: string | null;
  productLineScopeRecordId: string | null;
  seriesScopeRecordId: string | null;
  releaseDate: string | null;
  officialSetCode: string | null;
  languageEditions: readonly string[];
  lifecycleStatus: string;
  updatedAt: string;
}>;

export function scopeRecordDetailFromRow(row: CatalogScopeRecordRow): CatalogScopeRecordDetail {
  return {
    scopeRecordId: row.scope_record_id,
    productDomain: row.product_domain,
    scopeKind: row.scope_kind,
    referenceTypeKey: row.reference_type_key,
    referenceRecordId: row.reference_record_id,
    referenceRecordKey: row.reference_record_key,
    name: row.name,
    parentScopeRecordId: row.parent_scope_record_id,
    productLineScopeRecordId: row.product_line_scope_record_id,
    seriesScopeRecordId: row.series_scope_record_id,
    releaseDate: row.release_date,
    officialSetCode: row.official_set_code,
    languageEditions: normalizeLanguageEditions(row.language_editions),
    lifecycleStatus: row.lifecycle_status,
    updatedAt: row.updated_at,
  };
}

/** The canonical Scope Record list page the browser receives. */
export type CatalogScopeRecordListResponse = Readonly<{
  items: readonly CatalogScopeRecordDetail[];
  total: number;
  count: number;
}>;

export function catalogScopeRegistryRoutes(services: CatalogScopeRegistryRouteServices) {
  const app = new Hono<CatalogAuthoringEnv>();

  // Scope-first landing (`GET /scope-records`): the canonical Scope Record list
  // that drives the scope-first Catalog Home. Read-only, filterable by product
  // domain / scope kind / lifecycle status / free-text, and paginated. Language
  // edition is a client-side facet over the returned page (the column is a JSONB
  // array), so it is intentionally not a server filter here.
  app.get("/", async (c) => {
    const permissionError = requireCatalogViewPermission(c);
    if (permissionError) {
      return permissionError;
    }

    const params = scopeRecordListParamsFromQuery(c);
    const { items, total } = await services.listScopeRecords(params);
    const mapped = items.map(scopeRecordDetailFromRow);

    return c.json<CatalogScopeRecordListResponse>({ items: mapped, total, count: mapped.length });
  });

  app.get("/:id", async (c) => {
    const permissionError = requireCatalogViewPermission(c);
    if (permissionError) {
      return permissionError;
    }

    const scopeRecord = await services.getScopeRecord(c.req.param("id"));
    if (!scopeRecord) {
      return c.json(
        {
          error: {
            code: "not_found",
            message: t("catalog.features.scopeRegistry.api.route.scope.record.not.found"),
          },
        },
        404,
      );
    }

    return c.json(scopeRecordDetailFromRow(scopeRecord));
  });

  return app;
}

function scopeRecordListParamsFromQuery(c: Context<CatalogAuthoringEnv>): CatalogScopeRecordListParams {
  const query = c.req.query();
  const params: {
    -readonly [K in keyof CatalogScopeRecordListParams]: CatalogScopeRecordListParams[K];
  } = {
    limit: clampScopeListLimit(query.limit),
    offset: clampScopeListOffset(query.offset),
  };

  const search = query.search?.trim();
  if (search) {
    params.search = search;
  }
  const productDomain = matchEnum(query.productDomain, catalogScopeProductDomains);
  if (productDomain) {
    params.productDomain = productDomain;
  }
  const scopeKind = matchEnum(query.scopeKind, catalogScopeRecordKinds);
  if (scopeKind) {
    params.scopeKind = scopeKind;
  }
  const lifecycleStatus = matchEnum(query.status, catalogLifecycleStatuses);
  if (lifecycleStatus) {
    params.lifecycleStatus = lifecycleStatus;
  }
  const referenceRecordId = query.referenceRecordId?.trim();
  if (referenceRecordId) {
    params.referenceRecordId = referenceRecordId;
  }

  return params;
}

function matchEnum<T extends string>(value: string | undefined, allowed: readonly T[]): T | undefined {
  const normalized = value?.trim();
  return normalized && (allowed as readonly string[]).includes(normalized) ? (normalized as T) : undefined;
}

function clampScopeListLimit(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) {
    return SCOPE_LIST_DEFAULT_LIMIT;
  }
  return Math.max(1, Math.min(parsed, SCOPE_LIST_MAX_LIMIT));
}

function clampScopeListOffset(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function requireCatalogViewPermission(c: Context<CatalogAuthoringEnv>) {
  const actor = c.get("actor");
  if (!actor) {
    return c.json(authenticationRequiredResponse(), 401);
  }
  if (!actor.permissions.includes("catalog.view")) {
    return c.json(forbiddenResponse(), 403);
  }
  return null;
}

function normalizeLanguageEditions(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

export type { CatalogScopeRegistryRuntimeDeps };
