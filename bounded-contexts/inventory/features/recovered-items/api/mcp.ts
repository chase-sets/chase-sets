import { createActorEventStoreContext } from "@chase-sets/platform-runtime/auth";
import { readMcpStringArgument, type McpResourceHandler, type McpToolHandler } from "@chase-sets/platform-runtime/mcp";
import type { RecoveredItemServices } from "./runtime";
import type { RecoveredItemCommand, RecoveredItemDisposition, RecoveredValueType } from "../domain/recovered-item";
import { recoveredItemDispositions, recoveredValueTypes } from "../domain/recovered-item";

export type RecoveredItemMcpHandlers = Readonly<{
  toolHandlers: Readonly<Record<string, McpToolHandler>>;
  resourceHandlers: Readonly<Record<string, McpResourceHandler>>;
}>;

type OperatorActor = Parameters<typeof createActorEventStoreContext>[0];

function requiredString(args: Readonly<Record<string, unknown>>, key: string): string {
  const value = readMcpStringArgument(args, key);
  if (!value) throw new Error(`${key} is required.`);
  return value;
}

function requiredArray(args: Readonly<Record<string, unknown>>, key: string): readonly string[] {
  const value = args[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${key} must be an array of strings.`);
  }
  return value.map((entry) => entry.trim()).filter(Boolean);
}

function optionalString(args: Readonly<Record<string, unknown>>, key: string): string | null {
  return readMcpStringArgument(args, key);
}

function timestamp(args: Readonly<Record<string, unknown>>): string {
  return readMcpStringArgument(args, "occurredAt") ?? new Date().toISOString();
}

function operator(actor: OperatorActor | null, permission: string): OperatorActor {
  if (!actor || !actor.permissions.includes(permission)) {
    throw new Error(`Missing required permission: ${permission}.`);
  }
  return actor;
}

function actionResult(result: Awaited<ReturnType<RecoveredItemServices["execute"]>>) {
  return { recoveredItemId: result.recoveredItemId, version: result.version, status: result.state.status };
}

export function createRecoveredItemMcpHandlers(services: RecoveredItemServices): RecoveredItemMcpHandlers {
  const list: McpToolHandler = async ({ actor, arguments: args }) => {
    operator(actor, "recovered-inventory.view");
    const limitRaw = args.limit;
    const offsetRaw = args.offset;
    const limit = limitRaw === undefined ? 50 : Number(limitRaw);
    const offset = offsetRaw === undefined ? 0 : Number(offsetRaw);
    if (!Number.isInteger(limit) || limit <= 0) throw new Error("limit must be a positive integer.");
    if (!Number.isInteger(offset) || offset < 0) throw new Error("offset must be a non-negative integer.");
    const result = await services.list({ status: optionalString(args, "status"), limit, offset });
    return { items: result.items, total: result.total, count: result.items.length };
  };

  const metrics: McpToolHandler = async ({ actor }) => {
    operator(actor, "recovered-inventory.view");
    return services.metrics();
  };

  const execute =
    (
      permission: string,
      build: (
        args: Readonly<Record<string, unknown>>,
        actor: OperatorActor,
      ) => Exclude<RecoveredItemCommand, { type: "CreateRecoveredItem" }>,
    ): McpToolHandler =>
    async ({ actor, arguments: args }) => {
      const scopedActor = operator(actor, permission);
      const recoveredItemId = requiredString(args, "id");
      const command = build(args, scopedActor);
      const result = await services.execute(recoveredItemId, command, createActorEventStoreContext(scopedActor));
      return actionResult(result);
    };

  const identify = execute("recovered-inventory.manage", (args, actor) => ({
    type: "IdentifyRecoveredItem",
    catalogItemId: requiredString(args, "catalogItemId"),
    productId: requiredString(args, "productId"),
    selectedOptions: Array.isArray(args.selectedOptions)
      ? args.selectedOptions.map((entry) => {
          if (!entry || typeof entry !== "object") throw new Error("selectedOptions must contain objects.");
          const option = entry as Record<string, unknown>;
          return { dimensionId: requiredString(option, "dimensionId"), optionId: requiredString(option, "optionId") };
        })
      : (() => {
          throw new Error("selectedOptions must be an array.");
        })(),
    identifiedByUserId: actor.userId,
    evidenceReferences: requiredArray(args, "evidenceReferences"),
    identifiedAt: timestamp(args),
  }));

  const inspect = execute("recovered-inventory.manage", (args, actor) => ({
    type: "CompleteRecoveredItemInspection",
    conditionGrade: requiredString(args, "conditionGrade"),
    inspectedByUserId: actor.userId,
    evidenceReferences: requiredArray(args, "evidenceReferences"),
    inspectedAt: timestamp(args),
  }));

  const requireAuthenticity = execute("recovered-inventory.manage", (args, actor) => ({
    type: "RequireRecoveredItemAuthenticityReview",
    policyVersion: requiredString(args, "policyVersion"),
    reasonCode: requiredString(args, "reasonCode"),
    requestedByUserId: actor.userId,
    evidenceReferences: requiredArray(args, "evidenceReferences"),
    requestedAt: timestamp(args),
  }));

  const completeAuthenticity = execute("recovered-inventory.manage", (args, actor) => ({
    type: "CompleteRecoveredItemAuthenticityReview",
    outcome: requiredString(args, "outcome") as "authentic" | "not-authentic" | "inconclusive",
    reviewReference: requiredString(args, "reviewReference"),
    reviewedByUserId: actor.userId,
    evidenceReferences: requiredArray(args, "evidenceReferences"),
    reviewedAt: timestamp(args),
  }));

  const recordAuthority = execute("recovered-inventory.manage", (args, actor) => ({
    type: "RecordRecoveredItemDispositionAuthority",
    legalOwner: requiredString(args, "legalOwner") as "platform" | "original-seller" | "buyer" | "unknown",
    authorityKind: requiredString(args, "authorityKind") as
      | "terms-acceptance"
      | "explicit-consent"
      | "abandoned-property"
      | "carrier-settlement"
      | "legal-review",
    allowedDispositions: requiredArray(args, "allowedDispositions") as readonly RecoveredItemDisposition[],
    policyVersion: requiredString(args, "policyVersion"),
    authorizedByUserId: actor.userId,
    evidenceReferences: requiredArray(args, "evidenceReferences"),
    authorizedAt: timestamp(args),
  }));

  const decideDisposition = execute("recovered-inventory.manage", (args, actor) => ({
    type: "DecideRecoveredItemDisposition",
    disposition: requiredString(args, "disposition") as RecoveredItemDisposition,
    targetAccountId: optionalString(args, "targetAccountId"),
    storageLocationId: optionalString(args, "storageLocationId"),
    policyVersion: requiredString(args, "policyVersion"),
    decidedByUserId: actor.userId,
    evidenceReferences: requiredArray(args, "evidenceReferences"),
    reasonCode: requiredString(args, "reasonCode"),
    decidedAt: timestamp(args),
  }));

  const recordValue = execute("recovered-inventory.manage", (args, actor) => ({
    type: "RecordRecoveredItemValue",
    recoveryId: requiredString(args, "recoveryId"),
    recoveryType: requiredString(args, "recoveryType") as RecoveredValueType,
    grossAmount: requiredString(args, "grossAmount"),
    costAmount: requiredString(args, "costAmount"),
    currencyCode: requiredString(args, "currencyCode"),
    policyVersion: requiredString(args, "policyVersion"),
    evidenceReferences: requiredArray(args, "evidenceReferences"),
    recordedByUserId: actor.userId,
    recordedAt: timestamp(args),
  }));

  const correctSource = execute("recovered-inventory.manage", (args, actor) => ({
    type: "CorrectRecoveredItemSource",
    correctedReturnShipmentId: requiredString(args, "correctedReturnShipmentId"),
    reason: requiredString(args, "reason"),
    correctedByUserId: actor.userId,
    evidenceReferences: requiredArray(args, "evidenceReferences"),
    correctedAt: timestamp(args),
  }));

  const merge = execute("recovered-inventory.manage", (args, actor) => ({
    type: "MergeRecoveredItem",
    canonicalRecoveredItemId: requiredString(args, "canonicalRecoveredItemId"),
    reason: requiredString(args, "reason"),
    mergedByUserId: actor.userId,
    evidenceReferences: requiredArray(args, "evidenceReferences"),
    mergedAt: timestamp(args),
  }));

  // Keep the frozen route-to-command vocabulary visible at the composition seam.
  void recoveredItemDispositions;
  void recoveredValueTypes;
  return {
    toolHandlers: {
      "inventory.list-recovered-items": list,
      "inventory.get-recovered-item-metrics": metrics,
      "inventory.identify-recovered-item": identify,
      "inventory.inspect-recovered-item": inspect,
      "inventory.require-recovered-item-authenticity-review": requireAuthenticity,
      "inventory.complete-recovered-item-authenticity-review": completeAuthenticity,
      "inventory.record-recovered-item-disposition-authority": recordAuthority,
      "inventory.decide-recovered-item-disposition": decideDisposition,
      "inventory.record-recovered-item-value": recordValue,
      "inventory.correct-recovered-item-source": correctSource,
      "inventory.merge-recovered-item": merge,
    },
    resourceHandlers: {},
  };
}
