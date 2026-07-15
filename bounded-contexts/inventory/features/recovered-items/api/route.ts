import { Hono } from "hono";
import { t } from "@chase-sets/localization";
import type { InventoryApiEnv } from "../../../api";
import type { RecoveredItemCommand, RecoveredItemDisposition, RecoveredValueType } from "../domain/recovered-item";
import { recoveredItemDispositions, recoveredValueTypes } from "../domain/recovered-item";
import type { RecoveredItemServices } from "./runtime";

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function optionalText(value: unknown): string | null {
  const normalized = text(value);
  return normalized || null;
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function timestamp(value: unknown): string {
  return optionalText(value) ?? new Date().toISOString();
}

function commandFromBody(
  body: Record<string, unknown>,
  userId: string,
): Exclude<RecoveredItemCommand, { type: "CreateRecoveredItem" }> {
  const intent = text(body.intent);
  switch (intent) {
    case "identify":
      return {
        type: "IdentifyRecoveredItem",
        catalogItemId: text(body.catalogItemId),
        productId: text(body.productId),
        selectedOptions: Array.isArray(body.selectedOptions)
          ? body.selectedOptions.map((entry) => ({
              dimensionId: text((entry as Record<string, unknown>).dimensionId),
              optionId: text((entry as Record<string, unknown>).optionId),
            }))
          : [],
        identifiedByUserId: userId,
        evidenceReferences: strings(body.evidenceReferences),
        identifiedAt: timestamp(body.occurredAt),
      };
    case "inspect":
      return {
        type: "CompleteRecoveredItemInspection",
        conditionGrade: text(body.conditionGrade),
        inspectedByUserId: userId,
        evidenceReferences: strings(body.evidenceReferences),
        inspectedAt: timestamp(body.occurredAt),
      };
    case "require-authenticity-review":
      return {
        type: "RequireRecoveredItemAuthenticityReview",
        policyVersion: text(body.policyVersion),
        reasonCode: text(body.reasonCode),
        requestedByUserId: userId,
        evidenceReferences: strings(body.evidenceReferences),
        requestedAt: timestamp(body.occurredAt),
      };
    case "complete-authenticity-review":
      return {
        type: "CompleteRecoveredItemAuthenticityReview",
        outcome: text(body.outcome) as "authentic" | "not-authentic" | "inconclusive",
        reviewReference: text(body.reviewReference),
        reviewedByUserId: userId,
        evidenceReferences: strings(body.evidenceReferences),
        reviewedAt: timestamp(body.occurredAt),
      };
    case "record-authority":
      return {
        type: "RecordRecoveredItemDispositionAuthority",
        legalOwner: text(body.legalOwner) as "platform" | "original-seller" | "buyer" | "unknown",
        authorityKind: text(body.authorityKind) as
          | "terms-acceptance"
          | "explicit-consent"
          | "abandoned-property"
          | "carrier-settlement"
          | "legal-review",
        allowedDispositions: strings(body.allowedDispositions).filter((value): value is RecoveredItemDisposition =>
          recoveredItemDispositions.includes(value as RecoveredItemDisposition),
        ),
        policyVersion: text(body.policyVersion),
        authorizedByUserId: userId,
        evidenceReferences: strings(body.evidenceReferences),
        authorizedAt: timestamp(body.occurredAt),
      };
    case "decide-disposition":
      return {
        type: "DecideRecoveredItemDisposition",
        disposition: text(body.disposition) as RecoveredItemDisposition,
        targetAccountId: optionalText(body.targetAccountId),
        storageLocationId: optionalText(body.storageLocationId),
        policyVersion: text(body.policyVersion),
        decidedByUserId: userId,
        evidenceReferences: strings(body.evidenceReferences),
        reasonCode: text(body.reasonCode),
        decidedAt: timestamp(body.occurredAt),
      };
    case "record-value":
      return {
        type: "RecordRecoveredItemValue",
        recoveryId: text(body.recoveryId),
        recoveryType: text(body.recoveryType) as RecoveredValueType,
        grossAmount: text(body.grossAmount),
        costAmount: text(body.costAmount),
        currencyCode: text(body.currencyCode),
        policyVersion: text(body.policyVersion),
        evidenceReferences: strings(body.evidenceReferences),
        recordedByUserId: userId,
        recordedAt: timestamp(body.occurredAt),
      };
    case "correct-source":
      return {
        type: "CorrectRecoveredItemSource",
        correctedReturnShipmentId: text(body.correctedReturnShipmentId),
        reason: text(body.reason),
        correctedByUserId: userId,
        evidenceReferences: strings(body.evidenceReferences),
        correctedAt: timestamp(body.occurredAt),
      };
    case "merge":
      return {
        type: "MergeRecoveredItem",
        canonicalRecoveredItemId: text(body.canonicalRecoveredItemId),
        reason: text(body.reason),
        mergedByUserId: userId,
        evidenceReferences: strings(body.evidenceReferences),
        mergedAt: timestamp(body.occurredAt),
      };
    default:
      throw new Error(`Unsupported recovered item action '${intent}'.`);
  }
}

export function inventoryRecoveredItemRoutes(recoveredItems: RecoveredItemServices) {
  const app = new Hono<InventoryApiEnv>();

  app.get("/", async (c) => {
    const result = await recoveredItems.list({
      status: c.req.query("status") ?? null,
      limit: Number(c.req.query("limit") ?? 50),
      offset: Number(c.req.query("offset") ?? 0),
    });
    const canViewEvidence = c.get("actor").permissions.includes("recovered-inventory.evidence");
    return c.json({
      ...result,
      items: result.items.map((item) => ({
        ...item,
        evidence_references: canViewEvidence ? item.evidence_references : [],
        disposition_authority: canViewEvidence ? item.disposition_authority : null,
      })),
      count: result.items.length,
    });
  });

  app.get("/metrics", async (c) => c.json(await recoveredItems.metrics()));

  app.get("/:id", async (c) => {
    const item = await recoveredItems.get(c.req.param("id"));
    if (!item) {
      return c.json(
        { error: { code: "not_found", message: t("inventory.features.recoveredItems.api.route.not.found") } },
        404,
      );
    }
    if (!c.get("actor").permissions.includes("recovered-inventory.evidence")) {
      return c.json({ ...item, evidence_references: [], disposition_authority: null, audit: [], values: [] });
    }
    return c.json(item);
  });

  app.post("/:id/actions", async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    if (
      text(body.intent) === "record-value" &&
      !recoveredValueTypes.includes(text(body.recoveryType) as RecoveredValueType)
    ) {
      return c.json(
        {
          error: {
            code: "validation_failed",
            message: t("inventory.features.recoveredItems.api.route.unsupported.value.type"),
          },
        },
        400,
      );
    }
    const command = commandFromBody(body, c.get("context").audit.performedByUserId ?? "system");
    const result = await recoveredItems.execute(c.req.param("id"), command, c.get("context"));
    return c.json({ recoveredItemId: result.recoveredItemId, version: result.version, status: result.state.status });
  });

  return app;
}
