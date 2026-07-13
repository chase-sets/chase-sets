import { t } from "@chase-sets/localization";
import { Hono } from "hono";
import type { CatalogAuthoringEnv } from "../../../support/authoring-support/api";
import { requireCatalogIntegrationControlPlanePermission } from "../../source-observations/api/admin-control-plane-rbac";
import { catalogAliasStreamId } from "../domain/domain";
import type { CatalogAliasReviewFilter, CatalogAliasReviewReadModel } from "./alias-review-admin-contracts";
import type { CatalogAliasServices } from "./runtime";

// ---------------------------------------------------------------------------
// Catalog Alias review HTTP API
//
// The composition seam that makes the alias-review admin workspace reachable
// from the deployable. The deployable web routes talk to this context only over
// HTTP, so the read model and the accept/reject/revoke aggregate commands are
// exposed here:
//
//   GET  /alias-review            → the operator review read model for a scope.
//   POST /alias-review/commands   → accept / reject / revoke an alias candidate.
//
// Reads require catalog.view; writes require catalog.manage. Commands dispatch
// the Catalog Alias aggregate keyed by alias hash with the operator as actor,
// and return the committed aggregate snapshot so the workbench never reads a
// stale projection after a review action.
// ---------------------------------------------------------------------------

export type CatalogAliasRouteServices = Pick<
  CatalogAliasServices,
  "getCatalogAliasReviewReadModel" | "catalogAliasCommandHandler"
>;

/** The review actions an operator may dispatch over HTTP against the aggregate. */
const ALIAS_REVIEW_COMMAND_INTENTS = new Set(["accept", "reject", "revoke"]);

type AliasReviewCommandIntent = "accept" | "reject" | "revoke";

function isAliasReviewCommandIntent(value: string): value is AliasReviewCommandIntent {
  return ALIAS_REVIEW_COMMAND_INTENTS.has(value);
}

function reviewFilterFromQuery(query: Record<string, string | undefined>): Partial<CatalogAliasReviewFilter> {
  const reviewStatuses = (query.reviewStatuses ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean) as CatalogAliasReviewFilter["reviewStatuses"];
  const targetKind = (query.targetKind?.trim() as CatalogAliasReviewFilter["targetKind"]) || null;
  const targetId = query.targetId?.trim() || null;

  return {
    providerKey: query.providerKey?.trim() || null,
    sourceProfileVersion: query.sourceProfileVersion?.trim() || null,
    aliasType: (query.aliasType?.trim() as CatalogAliasReviewFilter["aliasType"]) || null,
    observationId: query.observationId?.trim() || null,
    reviewStatuses,
    // targetId without targetKind (or vice versa) is not a valid narrowing, so
    // only apply the pair when both are present.
    targetKind: targetId ? targetKind : null,
    targetId: targetKind ? targetId : null,
  };
}

function parseAliasHashes(value: unknown): readonly string[] {
  if (typeof value !== "string") {
    return [];
  }
  return [
    ...new Set(
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
}

export function catalogAliasRoutes(services: CatalogAliasRouteServices) {
  const app = new Hono<CatalogAuthoringEnv>();

  app.get("/", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "source-observation-read");
    if (permissionError) {
      return permissionError;
    }

    const candidateLimit = Number(c.req.query("limit")) || undefined;
    const readModel: CatalogAliasReviewReadModel = await services.getCatalogAliasReviewReadModel({
      generatedAt: new Date().toISOString(),
      filter: reviewFilterFromQuery(c.req.query()),
      candidateLimit,
    });

    return c.json(readModel);
  });

  app.post("/commands", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "source-observation-review");
    if (permissionError) {
      return permissionError;
    }

    const body = (await c.req.json().catch(() => ({}))) as {
      intent?: unknown;
      aliasHashes?: unknown;
      reason?: unknown;
    };
    const intent = String(body.intent ?? "").trim();
    if (!isAliasReviewCommandIntent(intent)) {
      return c.json(
        {
          error: {
            code: "alias_review_invalid_intent",
            message: t("catalog.features.aliasEquivalence.api.route.invalid.intent"),
          },
        },
        400,
      );
    }

    const aliasHashes = parseAliasHashes(body.aliasHashes);
    if (aliasHashes.length === 0) {
      return c.json(
        {
          error: {
            code: "alias_review_no_candidates",
            message: t("catalog.features.aliasEquivalence.api.route.no.candidates"),
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
            code: "alias_review_reason_required",
            message: t("catalog.features.aliasEquivalence.api.route.reason.required"),
          },
        },
        400,
      );
    }

    const context = c.get("context");
    const actor = context.audit.performedByUserId;
    const applied: Array<{ aliasHash: string; reviewStatus: string | null; version: number }> = [];

    for (const aliasHash of aliasHashes) {
      const result = await services.catalogAliasCommandHandler({
        streamId: catalogAliasStreamId(aliasHash),
        command: aliasReviewCommand(intent, actor, reason),
        context,
      });
      applied.push({ aliasHash, reviewStatus: result.state.reviewStatus, version: result.version });
    }

    return c.json({ intent, applied, count: applied.length });
  });

  return app;
}

function aliasReviewCommand(intent: AliasReviewCommandIntent, actor: string, reason: string) {
  switch (intent) {
    case "accept":
      return { type: "AcceptCatalogAlias", actor, reason: reason || null } as const;
    case "reject":
      return { type: "RejectCatalogAlias", actor, reason } as const;
    case "revoke":
      return { type: "RevokeCatalogAlias", actor, reason } as const;
  }
}
