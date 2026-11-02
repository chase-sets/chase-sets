import { createActorEventStoreContext, type ResolvedActor } from "@chase-sets/platform-runtime/auth";
import {
  readMcpStringArgument,
  readMcpTypedIdArgument,
  type McpResourceHandler,
  type McpToolHandler,
} from "@chase-sets/platform-runtime/mcp";
import type { ReturnIntakeEvidenceAttachment, ReturnIntakeDiscrepancy } from "../domain/facility-intake";
import type { FulfillmentReturnShipmentServices } from "./runtime";
import { unidentifiedReturnPackageStreamId } from "./runtime";

export type FulfillmentReturnIntakeMcpHandlers = Readonly<{
  toolHandlers: Readonly<Record<string, McpToolHandler>>;
  resourceHandlers: Readonly<Record<string, McpResourceHandler>>;
}>;

function requiredString(args: Readonly<Record<string, unknown>>, key: string): string {
  const value = readMcpStringArgument(args, key);
  if (!value) throw new Error(`${key} is required.`);
  return value;
}

function requiredId<Prefix extends string>(
  args: Readonly<Record<string, unknown>>,
  key: string,
  prefix: Prefix,
): string {
  return readMcpTypedIdArgument(args, key, prefix);
}

function requiredPermission(actor: ResolvedActor | null, permission: string): ResolvedActor {
  if (!actor) throw new Error("An authenticated operator is required.");
  if (!actor.permissions.includes(permission)) throw new Error(`Missing required permission: ${permission}.`);
  return actor;
}

function optionalNumber(args: Readonly<Record<string, unknown>>, key: string): number | null {
  const raw = args[key];
  if (raw === null || raw === undefined || raw === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${key} must be a number.`);
  return value;
}

function requiredEvidence(args: Readonly<Record<string, unknown>>): readonly ReturnIntakeEvidenceAttachment[] {
  if (!Array.isArray(args.evidence)) throw new Error("evidence is required.");
  return args.evidence as readonly ReturnIntakeEvidenceAttachment[];
}

function requiredDiscrepancies(args: Readonly<Record<string, unknown>>): readonly ReturnIntakeDiscrepancy[] {
  if (!Array.isArray(args.discrepancies)) throw new Error("discrepancies is required.");
  return args.discrepancies as readonly ReturnIntakeDiscrepancy[];
}

function rejectDryRun(args: Readonly<Record<string, unknown>>) {
  if (args.dryRun === true) throw new Error("dryRun is not supported for return-intake MCP writes.");
}

export function createFulfillmentReturnIntakeMcpHandlers(
  services: FulfillmentReturnShipmentServices,
): FulfillmentReturnIntakeMcpHandlers {
  const getQueue: McpToolHandler = async ({ actor, arguments: args }) => {
    requiredPermission(actor, "return-intake.view");
    const facilityId = requiredString(args, "facilityId");
    const [items, unidentified, metrics] = await Promise.all([
      services.listFacilityIntakeQueue(facilityId),
      services.listUnidentifiedPackages(facilityId),
      services.getIntakeMetrics(facilityId),
    ]);
    return { facilityId, items, unidentified, metrics };
  };

  const resolve: McpToolHandler = async ({ actor, arguments: args }) => {
    requiredPermission(actor, "return-intake.view");
    const facilityId = requiredString(args, "facilityId");
    const identifier = requiredString(args, "identifier");
    const result = await services.resolveForIntake(identifier, facilityId);
    if (result.outcome !== "resolved") return result;
    return { ...result, version: await services.getReturnShipmentVersion(result.shipment.return_shipment_id) };
  };

  const complete: McpToolHandler = async ({ actor, arguments: args }) => {
    rejectDryRun(args);
    const operator = requiredPermission(actor, "return-intake.manage");
    const facilityId = requiredString(args, "facilityId");
    const returnShipmentId = requiredId(args, "returnShipmentId", "rsh");
    const resolved = await services.resolveForIntake(returnShipmentId, facilityId);
    if (resolved.outcome !== "resolved") throw new Error("Return shipment is not expected at this facility.");
    const evidence = requiredEvidence(args);
    await services.verifyEvidence(facilityId, evidence);
    const idempotencyKey = requiredString(args, "idempotencyKey");
    const result = await services.completeFacilityIntake({
      returnShipmentId,
      expectedVersion: Number.isInteger(args.expectedVersion) ? Number(args.expectedVersion) : undefined,
      context: createActorEventStoreContext(operator),
      command: {
        type: "CompleteReturnShipmentFacilityIntake",
        intake: {
          facilityId,
          stationId: requiredString(args, "stationId"),
          operatorUserId: operator.userId,
          receivedAt: requiredString(args, "receivedAt"),
          packageCondition: requiredString(args, "packageCondition") as never,
          sealCondition: requiredString(args, "sealCondition") as never,
          measuredWeightOunces: optionalNumber(args, "measuredWeightOunces"),
          evidence,
          discrepancies: requiredDiscrepancies(args),
          disposition: requiredString(args, "disposition") as never,
          custodyIdentifier: requiredString(args, "custodyIdentifier"),
          idempotencyKey,
        },
        metadata: {
          correlationRemedyId: resolved.shipment.remedy_id as never,
          causationId: null,
          idempotencyKey,
          policyVersion: "return-intake-v1",
        },
      },
    });
    return {
      returnShipmentId,
      version: result.version,
      intake: result.state.facilityIntake,
      duplicate: result.newEvents.some(
        (event) => event.type === "fulfillment.return-shipment.duplicate-intake-scan-observed.v1",
      ),
    };
  };

  const correct: McpToolHandler = async ({ actor, arguments: args }) => {
    rejectDryRun(args);
    const operator = requiredPermission(actor, "return-intake.manage");
    const facilityId = requiredString(args, "facilityId");
    const returnShipmentId = requiredId(args, "returnShipmentId", "rsh");
    const resolved = await services.resolveForIntake(returnShipmentId, facilityId);
    if (resolved.outcome !== "resolved") throw new Error("Return shipment was not found.");
    const correctionId = requiredString(args, "correctionId");
    const result = await services.commandHandler({
      streamId: services.streamIdFor(returnShipmentId),
      context: createActorEventStoreContext(operator),
      expectedVersion: Number.isInteger(args.expectedVersion) ? Number(args.expectedVersion) : undefined,
      command: {
        type: "CorrectReturnShipmentFacilityIntake",
        correction: {
          correctionId,
          reason: requiredString(args, "reason"),
          correctedByUserId: operator.userId,
          correctedAt: new Date().toISOString(),
          owner: args.owner == null ? null : String(args.owner),
          nextAction: args.nextAction == null ? null : String(args.nextAction),
          custodyIdentifier: args.custodyIdentifier == null ? null : String(args.custodyIdentifier),
        },
        metadata: {
          correlationRemedyId: resolved.shipment.remedy_id as never,
          causationId: null,
          idempotencyKey: correctionId,
          policyVersion: "return-intake-v1",
        },
      },
    });
    return { returnShipmentId, version: result.version };
  };

  const recordUnidentified: McpToolHandler = async ({ actor, arguments: args }) => {
    rejectDryRun(args);
    const operator = requiredPermission(actor, "return-intake.manage");
    const facilityId = requiredString(args, "facilityId");
    const unidentifiedPackageId = requiredId(args, "unidentifiedPackageId", "urp");
    const evidence = requiredEvidence(args);
    await services.verifyEvidence(facilityId, evidence);
    const result = await services.unidentifiedPackageCommandHandler({
      streamId: unidentifiedReturnPackageStreamId(unidentifiedPackageId),
      context: createActorEventStoreContext(operator),
      command: {
        type: "RecordUnidentifiedReturnPackage",
        unidentifiedPackageId: unidentifiedPackageId as never,
        facilityId,
        stationId: requiredString(args, "stationId"),
        operatorUserId: operator.userId,
        receivedAt: requiredString(args, "receivedAt"),
        packageCondition: requiredString(args, "packageCondition"),
        sealCondition: requiredString(args, "sealCondition"),
        measuredWeightOunces: optionalNumber(args, "measuredWeightOunces"),
        evidence,
        custodyIdentifier: requiredString(args, "custodyIdentifier"),
        notes: args.notes == null ? null : String(args.notes),
        owner: requiredString(args, "owner"),
        nextAction: requiredString(args, "nextAction"),
      },
    });
    return { unidentifiedPackageId, version: result.version };
  };

  const reconcile: McpToolHandler = async ({ actor, arguments: args }) => {
    rejectDryRun(args);
    const operator = requiredPermission(actor, "return-intake.manage");
    const unidentifiedPackageId = requiredId(args, "unidentifiedPackageId", "urp");
    const unidentified = await services.getUnidentifiedPackage(unidentifiedPackageId);
    if (!unidentified) throw new Error("Unidentified package was not found.");
    const returnShipmentId = requiredId(args, "returnShipmentId", "rsh");
    const target = await services.resolveForIntake(returnShipmentId, unidentified.facility_id);
    if (target.outcome !== "resolved") throw new Error("Return shipment is not expected at this facility.");
    const result = await services.unidentifiedPackageCommandHandler({
      streamId: unidentifiedReturnPackageStreamId(unidentifiedPackageId),
      context: createActorEventStoreContext(operator),
      command: {
        type: "ReconcileUnidentifiedReturnPackage",
        returnShipmentId: target.shipment.return_shipment_id as never,
        reconciledByUserId: operator.userId,
        reconciledAt: new Date().toISOString(),
        reason: requiredString(args, "reason"),
      },
    });
    return { unidentifiedPackageId, returnShipmentId: target.shipment.return_shipment_id, version: result.version };
  };

  return {
    toolHandlers: {
      "fulfillment.complete-return-intake": complete,
      "fulfillment.correct-return-intake": correct,
      "fulfillment.get-return-intake-queue": getQueue,
      "fulfillment.reconcile-unidentified-return-package": reconcile,
      "fulfillment.record-unidentified-return-package": recordUnidentified,
      "fulfillment.resolve-return-intake": resolve,
    },
    resourceHandlers: {},
  };
}
