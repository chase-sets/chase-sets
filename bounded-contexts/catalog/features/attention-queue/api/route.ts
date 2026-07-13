import { t } from "@chase-sets/localization";
import { Hono, type Context } from "hono";
import type { CatalogAuthoringEnv } from "../../../support/authoring-support/api";
import { requireCatalogIntegrationControlPlanePermission } from "../../source-observations/api/admin-control-plane-rbac";
import { CATALOG_ATTENTION_ITEM_KINDS, type CatalogAttentionItemKind } from "../read-model/attention-item";
import { catalogAttentionDismissalStreamId } from "../domain/dismissal";
import type { CatalogAttentionQueueServices } from "./runtime";

// ---------------------------------------------------------------------------
// Catalog attention queue HTTP API
//
//   GET  /attention-queue          → the unified needs-you read model.
//   POST /attention-queue/commands → park (dismiss / defer) or restore an item.
//
// Reads require catalog.view; park/restore require catalog.manage. Every command
// dispatches the attention-dismissal aggregate keyed by the item key, so parking
// the same item is idempotent and the audit trail is retained.
// ---------------------------------------------------------------------------

export type CatalogAttentionQueueRouteServices = Pick<
  CatalogAttentionQueueServices,
  "getCatalogAttentionQueueReadModel" | "catalogAttentionDismissalCommandHandler"
>;

type AttentionCommandIntent = "dismiss" | "defer" | "restore";

const ATTENTION_COMMAND_INTENTS = new Set<string>(["dismiss", "defer", "restore"]);

function isAttentionCommandIntent(value: string): value is AttentionCommandIntent {
  return ATTENTION_COMMAND_INTENTS.has(value);
}

function isAttentionItemKind(value: unknown): value is CatalogAttentionItemKind {
  return typeof value === "string" && (CATALOG_ATTENTION_ITEM_KINDS as readonly string[]).includes(value);
}

export function catalogAttentionQueueRoutes(services: CatalogAttentionQueueRouteServices) {
  const app = new Hono<CatalogAuthoringEnv>();

  app.get("/", async (c) => {
    const permissionError = requireCatalogIntegrationControlPlanePermission(c, "source-observation-read");
    if (permissionError) {
      return permissionError;
    }

    const context = c.get("context");
    const readModel = await services.getCatalogAttentionQueueReadModel({
      context,
      generatedAt: new Date().toISOString(),
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
      itemKey?: unknown;
      kind?: unknown;
      reason?: unknown;
      deferredUntil?: unknown;
      deferHours?: unknown;
    };

    const intent = String(body.intent ?? "").trim();
    if (!isAttentionCommandIntent(intent)) {
      return invalidRequest(
        c,
        "attention_queue_invalid_intent",
        t("catalog.features.attentionQueue.api.route.invalidIntent"),
      );
    }

    const itemKey = String(body.itemKey ?? "").trim();
    if (!itemKey) {
      return invalidRequest(c, "attention_queue_no_item", t("catalog.features.attentionQueue.api.route.itemRequired"));
    }

    const context = c.get("context");
    const actor = context.audit.performedByUserId;

    if (intent === "restore") {
      const result = await services.catalogAttentionDismissalCommandHandler({
        streamId: catalogAttentionDismissalStreamId(itemKey),
        command: { type: "RestoreAttentionItem", itemKey, actor },
        context,
      });
      return c.json({ intent, itemKey, disposition: result.state.disposition, version: result.version });
    }

    if (!isAttentionItemKind(body.kind)) {
      return invalidRequest(
        c,
        "attention_queue_invalid_kind",
        t("catalog.features.attentionQueue.api.route.kindRequired"),
      );
    }
    const kind = body.kind;
    const reason = String(body.reason ?? "").trim();
    if (!reason) {
      return invalidRequest(
        c,
        "attention_queue_reason_required",
        t("catalog.features.attentionQueue.api.route.reasonRequired"),
      );
    }

    if (intent === "dismiss") {
      const result = await services.catalogAttentionDismissalCommandHandler({
        streamId: catalogAttentionDismissalStreamId(itemKey),
        command: { type: "DismissAttentionItem", itemKey, kind, actor, reason },
        context,
      });
      return c.json({ intent, itemKey, disposition: result.state.disposition, version: result.version });
    }

    const deferredUntil = resolveDeferredUntil(body.deferredUntil, body.deferHours);
    if (!deferredUntil) {
      return invalidRequest(
        c,
        "attention_queue_defer_time_required",
        t("catalog.features.attentionQueue.api.route.deferTimeRequired"),
      );
    }
    const result = await services.catalogAttentionDismissalCommandHandler({
      streamId: catalogAttentionDismissalStreamId(itemKey),
      command: { type: "DeferAttentionItem", itemKey, kind, actor, reason, deferredUntil },
      context,
    });
    return c.json({ intent, itemKey, disposition: result.state.disposition, deferredUntil, version: result.version });
  });

  return app;
}

function resolveDeferredUntil(deferredUntil: unknown, deferHours: unknown): string | null {
  if (typeof deferredUntil === "string" && Number.isFinite(Date.parse(deferredUntil))) {
    return new Date(deferredUntil).toISOString();
  }
  const hours = Number(deferHours);
  if (Number.isFinite(hours) && hours > 0) {
    return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
  }
  return null;
}

function invalidRequest(c: Context<CatalogAuthoringEnv>, code: string, message: string) {
  return c.json({ error: { code, message } }, 400);
}
