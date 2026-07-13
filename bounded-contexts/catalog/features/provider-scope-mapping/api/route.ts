import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import type { CatalogAuthoringEnv } from "../../../support/authoring-support/api";
import { requireCatalogIntegrationControlPlanePermission } from "../../source-observations/api/admin-control-plane-rbac";
import { CATALOG_PROVIDER_SCOPE_MAPPING_STREAM_PREFIX } from "../domain/domain";
import { buildProviderScopeMappingCandidate, type ProviderScopeMappingConfidenceTier } from "../domain/mapping";
import type { ProviderScopeMappingServices } from "./runtime";

const MANUAL_PROPOSAL_CONFIDENCE_TIERS: readonly ProviderScopeMappingConfidenceTier[] = [
  "exact",
  "high",
  "candidate",
  "generated",
  "manual",
];

function normalizeManualConfidence(value: unknown): ProviderScopeMappingConfidenceTier {
  return typeof value === "string" &&
    MANUAL_PROPOSAL_CONFIDENCE_TIERS.includes(value as ProviderScopeMappingConfidenceTier)
    ? (value as ProviderScopeMappingConfidenceTier)
    : "manual";
}

// ---------------------------------------------------------------------------
// Provider Scope Mapping review HTTP API
//
// Reachable from the deployable only over HTTP, mirroring the Catalog Alias
// review route (features/alias-equivalence/api/route.ts):
//
//   GET  /inbox                → unmapped-scope inbox (proposed mappings, grouped by scope record).
//   GET  /coverage/:scopeRecordId → the coverage matrix for one canonical scope record.
//   POST /commands              → accept / reject / revoke one or more mappings.
//   POST /propose                → manually propose (and optionally accept) a mapping;
//                                   the "map a new expansion in a few clicks" and
//                                   "create a canonical record from a proposal" entry point
//                                   until the scheduled matcher lands.
//
// Reads require catalog.view; writes require catalog.manage.
// ---------------------------------------------------------------------------

const REVIEW_INTENTS = new Set(["accept", "reject", "revoke"]);

type ReviewIntent = "accept" | "reject" | "revoke";

function isReviewIntent(value: string): value is ReviewIntent {
  return REVIEW_INTENTS.has(value);
}

function parseMappingIds(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0))];
}

export function providerScopeMappingRoutes(services: ProviderScopeMappingServices) {
  const app = new Hono<CatalogAuthoringEnv>();

  app.get("/inbox", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "source-observation-read");
    if (permissionError) {
      return permissionError;
    }

    const limit = Number(c.req.query("limit")) || undefined;
    const inbox = await services.getUnmappedScopeInbox({ limit });
    return c.json(inbox);
  });

  app.get("/coverage/:scopeRecordId", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "source-observation-read");
    if (permissionError) {
      return permissionError;
    }

    const matrix = await services.getScopeCoverageMatrix(c.req.param("scopeRecordId"));
    if (!matrix) {
      return c.json(
        {
          error: {
            code: "not_found",
            message: t("catalog.features.providerScopeMapping.api.route.scope.record.not.found"),
          },
        },
        404,
      );
    }
    return c.json(matrix);
  });

  app.post("/commands", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "source-observation-review");
    if (permissionError) {
      return permissionError;
    }

    const body = (await c.req.json().catch(() => ({}))) as {
      intent?: unknown;
      mappingIds?: unknown;
      reason?: unknown;
    };
    const intent = String(body.intent ?? "").trim();
    if (!isReviewIntent(intent)) {
      return c.json(
        {
          error: {
            code: "provider_scope_mapping_invalid_intent",
            message: t("catalog.features.providerScopeMapping.api.route.invalid.intent"),
          },
        },
        400,
      );
    }

    const mappingIds = parseMappingIds(body.mappingIds);
    if (mappingIds.length === 0) {
      return c.json(
        {
          error: {
            code: "provider_scope_mapping_no_candidates",
            message: t("catalog.features.providerScopeMapping.api.route.no.candidates"),
          },
        },
        400,
      );
    }

    const reason = String(body.reason ?? "").trim();
    if ((intent === "reject" || intent === "revoke") && !reason) {
      return c.json(
        {
          error: {
            code: "provider_scope_mapping_reason_required",
            message: t("catalog.features.providerScopeMapping.api.route.reason.required"),
          },
        },
        400,
      );
    }

    const context = c.get("context");
    const actor = context.audit.performedByUserId;
    const applied: Array<{ mappingId: string; reviewStatus: string | null; version: number }> = [];

    for (const mappingId of mappingIds) {
      const result = await services.commandHandler({
        streamId: `${CATALOG_PROVIDER_SCOPE_MAPPING_STREAM_PREFIX}${mappingId}`,
        command: reviewCommand(intent, actor, reason),
        context,
      });
      applied.push({ mappingId, reviewStatus: result.state.reviewStatus, version: result.version });
    }

    return c.json({ intent, applied, count: applied.length });
  });

  app.post("/propose", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "source-observation-review");
    if (permissionError) {
      return permissionError;
    }

    const body = (await c.req.json().catch(() => ({}))) as {
      scopeRecordId?: unknown;
      providerKey?: unknown;
      unitKey?: unknown;
      coordinates?: unknown;
      confidence?: unknown;
      autoAccept?: unknown;
      reason?: unknown;
    };

    const scopeRecordId = String(body.scopeRecordId ?? "").trim();
    const providerKey = String(body.providerKey ?? "").trim();
    const unitKey = String(body.unitKey ?? "").trim();
    const coordinates = isRecord(body.coordinates) ? body.coordinates : {};

    if (!scopeRecordId || !providerKey || !unitKey) {
      return c.json(
        {
          error: {
            code: "provider_scope_mapping_missing_fields",
            message: t("catalog.features.providerScopeMapping.api.route.missing.fields"),
          },
        },
        400,
      );
    }

    const context = c.get("context");
    const actor = context.audit.performedByUserId;

    const candidate = buildProviderScopeMappingCandidate({
      scopeRecordId,
      providerKey,
      unitKey,
      coordinates: {
        productLineId: stringOrNull(coordinates.productLineId),
        seriesId: stringOrNull(coordinates.seriesId),
        setId: stringOrNull(coordinates.setId),
        setName: stringOrNull(coordinates.setName),
      },
      confidence: normalizeManualConfidence(body.confidence),
      reviewStatus: "proposed",
      provenance: { source: "operator-manual-mapping" },
    });

    const proposeResult = await services.commandHandler({
      streamId: `${CATALOG_PROVIDER_SCOPE_MAPPING_STREAM_PREFIX}${candidate.mappingId}`,
      command: { type: "ProposeProviderScopeMapping", candidate, actor },
      context,
    });

    if (!body.autoAccept) {
      return c.json(
        {
          mappingId: candidate.mappingId,
          reviewStatus: proposeResult.state.reviewStatus,
          version: proposeResult.version,
        },
        201,
      );
    }

    const acceptResult = await services.commandHandler({
      streamId: `${CATALOG_PROVIDER_SCOPE_MAPPING_STREAM_PREFIX}${candidate.mappingId}`,
      command: {
        type: "AcceptProviderScopeMapping",
        actor,
        reason: typeof body.reason === "string" ? body.reason : null,
      },
      context,
    });

    return c.json(
      { mappingId: candidate.mappingId, reviewStatus: acceptResult.state.reviewStatus, version: acceptResult.version },
      201,
    );
  });

  return app;
}

function reviewCommand(intent: ReviewIntent, actor: string, reason: string) {
  switch (intent) {
    case "accept":
      return { type: "AcceptProviderScopeMapping", actor, reason: reason || null } as const;
    case "reject":
      return { type: "RejectProviderScopeMapping", actor, reason } as const;
    case "revoke":
      return { type: "RevokeProviderScopeMapping", actor, reason } as const;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
