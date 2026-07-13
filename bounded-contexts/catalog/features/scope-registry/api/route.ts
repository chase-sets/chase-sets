import { authenticationRequiredResponse, forbiddenResponse } from "@chase-sets/http/responses";
import { Hono, type Context } from "hono";
import { t } from "@chase-sets/localization";
import type { CatalogAuthoringEnv } from "../../../support/authoring-support/api";
import type { CatalogScopeRegistryRuntimeDeps } from "./runtime";
import type { createCatalogScopeRegistryRuntime } from "./runtime";
import type { CatalogScopeRecordRow } from "../read-model/queries";

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

export function catalogScopeRegistryRoutes(services: CatalogScopeRegistryRouteServices) {
  const app = new Hono<CatalogAuthoringEnv>();

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
