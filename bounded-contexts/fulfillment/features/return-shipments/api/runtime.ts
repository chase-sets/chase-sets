import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext, ExpectedStreamVersion } from "@chase-sets/event-core/storage";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { PostageLabelProvider } from "@chase-sets/postage-labels";
import {
  decideReturnShipment,
  evolveReturnShipment,
  initialReturnShipmentState,
  type ReturnShipmentCommand,
  type ReturnShipmentEvent,
  type ReturnShipmentState,
} from "../domain/domain";
import { createReturnFacilityDirectory, type ReturnFacilityDirectory } from "../domain/facility-directory";
import type { ReturnIntakeEvidenceAttachment } from "../domain/facility-intake";
import {
  decideUnidentifiedReturnPackage,
  evolveUnidentifiedReturnPackage,
  initialUnidentifiedReturnPackageState,
  type UnidentifiedReturnPackageCommand,
  type UnidentifiedReturnPackageEvent,
  type UnidentifiedReturnPackageState,
} from "../domain/unidentified-package";
import {
  storeReturnIntakeEvidence,
  verifyStoredReturnIntakeEvidence,
  type ReturnIntakeEvidenceSecurityScanner,
  type ReturnIntakeEvidenceStorage,
  type ReturnIntakeEvidenceUpload,
} from "./evidence";
import { buildFulfillmentReturnShipmentProjectionHandlers } from "../read-model/projection";
import {
  findReturnShipmentIdForRemedy,
  getReturnIntakeEvidenceReference,
  getReturnIntakeMetrics,
  getUnidentifiedReturnPackage,
  listFacilityReturnIntakeQueue,
  listUnidentifiedReturnPackages,
  getCustomerReturnShipment,
  getOperatorReturnShipment,
  listCustomerReturnShipmentsForRemedy,
  resolveOperatorReturnShipmentForIntake,
} from "../read-model/queries";
import { createReturnShipmentLabelPurchaseService, type ReturnShipmentLabelPurchaseService } from "./label-purchase";
import { loadReturnShipmentLinkageSource } from "../read-model/linkage";
import { processReturnShipmentTrackingEvent, type ReturnShipmentTrackingIngestionResult } from "./tracking-ingestion";
import type { PostageProviderWebhookEvent } from "@chase-sets/postage-labels";

export const FULFILLMENT_RETURN_SHIPMENT_PROJECTION = "fulfillment-return-shipment-projection";

/** The event-store stream that carries one reverse shipment's fact log. */
export function returnShipmentStreamId(returnShipmentId: string): string {
  return `fulfillment.return-shipment-${returnShipmentId}`;
}

export function unidentifiedReturnPackageStreamId(unidentifiedPackageId: string): string {
  return `fulfillment.unidentified-return-package-${unidentifiedPackageId}`;
}

type ReturnShipmentRuntimeDeps = Readonly<{
  eventStore: EventStore;
  db: PgQueryable;
  postageLabelProvider?: PostageLabelProvider;
  facilityDirectory?: ReturnFacilityDirectory;
  evidenceStorage?: ReturnIntakeEvidenceStorage;
  evidenceSecurityScanner?: ReturnIntakeEvidenceSecurityScanner;
}>;

export type FulfillmentReturnShipmentServices = Readonly<{
  commandHandler: CommandHandler<ReturnShipmentCommand, ReturnShipmentState, ReturnShipmentEvent>;
  unidentifiedPackageCommandHandler: CommandHandler<
    UnidentifiedReturnPackageCommand,
    UnidentifiedReturnPackageState,
    UnidentifiedReturnPackageEvent
  >;
  streamIdFor: (returnShipmentId: string) => string;
  labelPurchase: ReturnShipmentLabelPurchaseService;
  getCustomerReturnShipment: (returnShipmentId: string) => ReturnType<typeof getCustomerReturnShipment>;
  listCustomerReturnShipmentsForRemedy: (remedyId: string) => ReturnType<typeof listCustomerReturnShipmentsForRemedy>;
  getOperatorReturnShipment: (returnShipmentId: string) => ReturnType<typeof getOperatorReturnShipment>;
  findReturnShipmentIdForRemedy: (remedyId: string) => ReturnType<typeof findReturnShipmentIdForRemedy>;
  resolveForIntake: (
    identifier: string,
    facilityId: string,
  ) => ReturnType<typeof resolveOperatorReturnShipmentForIntake>;
  getReturnShipmentVersion: (returnShipmentId: string) => Promise<number>;
  listFacilityIntakeQueue: (facilityId: string) => ReturnType<typeof listFacilityReturnIntakeQueue>;
  getUnidentifiedPackage: (unidentifiedPackageId: string) => ReturnType<typeof getUnidentifiedReturnPackage>;
  listUnidentifiedPackages: (facilityId: string) => ReturnType<typeof listUnidentifiedReturnPackages>;
  getIntakeMetrics: (facilityId: string) => ReturnType<typeof getReturnIntakeMetrics>;
  getEvidenceReference: (
    attachmentId: string,
    facilityId: string,
  ) => ReturnType<typeof getReturnIntakeEvidenceReference>;
  completeFacilityIntake: (
    input: Readonly<{
      returnShipmentId: string;
      command: Extract<ReturnShipmentCommand, { type: "CompleteReturnShipmentFacilityIntake" }>;
      context: EventStoreContext;
      expectedVersion?: ExpectedStreamVersion;
    }>,
  ) => ReturnType<CommandHandler<ReturnShipmentCommand, ReturnShipmentState, ReturnShipmentEvent>>;
  uploadEvidence: (
    input: Readonly<{
      upload: ReturnIntakeEvidenceUpload;
      facilityId: string;
      uploadedAt: string;
    }>,
  ) => ReturnType<typeof storeReturnIntakeEvidence>;
  getEvidence: (storageKey: string) => Promise<Awaited<ReturnType<ReturnIntakeEvidenceStorage["getObject"]>>>;
  verifyEvidence: (facilityId: string, attachments: readonly ReturnIntakeEvidenceAttachment[]) => Promise<void>;
  /**
   * Ingests one normalized carrier tracking event for a reverse shipment. Backs
   * both live provider webhooks (routed here when no outbound shipment matches) and
   * the scheduled reconciliation/poll path; both are exact-once by construction.
   */
  processTrackingEvent: (
    event: PostageProviderWebhookEvent,
    context: EventStoreContext,
  ) => Promise<ReturnShipmentTrackingIngestionResult>;
  projectors: readonly ProjectionHandlerSet[];
}>;

/**
 * A postage provider that is never configured. Slices that do not wire a real
 * provider still compose the label-purchase service, but any purchase/void attempt
 * fails loudly rather than silently succeeding.
 */
function createUnconfiguredReturnPostageLabelProvider(): PostageLabelProvider {
  const fail = async (): Promise<never> => {
    throw new Error("No postage label provider is configured for return-shipment label purchase.");
  };
  return {
    providerName: "unconfigured",
    providerMode: "test",
    purchaseUspsLabel: fail,
    voidLabel: fail,
  };
}

/**
 * Composition root for the ReturnShipment slice. Provides the aggregate command
 * handler, the return-label purchase/void workflow, the read-model query surface,
 * and the projection handler set that the fulfillment module registers. Carrier
 * tracking ingestion is provided via `processTrackingEvent`; policy-driven refund
 * release is owned by Platform Operations, which correlates the milestone facts
 * this slice publishes to the authorized refund trigger.
 */
export function createFulfillmentReturnShipmentRuntime(
  deps: ReturnShipmentRuntimeDeps,
): FulfillmentReturnShipmentServices {
  const { commandHandler, repository } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<ReturnShipmentEvent>(),
    initialState: () => initialReturnShipmentState,
    evolve: evolveReturnShipment,
    decide: decideReturnShipment,
  });
  const { commandHandler: unidentifiedPackageCommandHandler } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<UnidentifiedReturnPackageEvent>(),
    initialState: () => initialUnidentifiedReturnPackageState,
    evolve: evolveUnidentifiedReturnPackage,
    decide: decideUnidentifiedReturnPackage,
  });

  const labelPurchase = createReturnShipmentLabelPurchaseService({
    eventStore: deps.eventStore,
    db: deps.db,
    postageLabelProvider: deps.postageLabelProvider ?? createUnconfiguredReturnPostageLabelProvider(),
    facilityDirectory: deps.facilityDirectory ?? createReturnFacilityDirectory([]),
    loadLinkageSource: (linkage) => loadReturnShipmentLinkageSource(deps.db, linkage),
  });

  return {
    commandHandler,
    unidentifiedPackageCommandHandler,
    streamIdFor: returnShipmentStreamId,
    labelPurchase,
    getCustomerReturnShipment: (returnShipmentId) => getCustomerReturnShipment(deps.db, returnShipmentId),
    listCustomerReturnShipmentsForRemedy: (remedyId) => listCustomerReturnShipmentsForRemedy(deps.db, remedyId),
    getOperatorReturnShipment: (returnShipmentId) => getOperatorReturnShipment(deps.db, returnShipmentId),
    findReturnShipmentIdForRemedy: (remedyId) => findReturnShipmentIdForRemedy(deps.db, remedyId),
    resolveForIntake: (identifier, facilityId) =>
      resolveOperatorReturnShipmentForIntake(deps.db, identifier, facilityId),
    getReturnShipmentVersion: async (returnShipmentId) =>
      (await repository.load(returnShipmentStreamId(returnShipmentId))).version,
    listFacilityIntakeQueue: (facilityId) => listFacilityReturnIntakeQueue(deps.db, facilityId),
    getUnidentifiedPackage: (unidentifiedPackageId) => getUnidentifiedReturnPackage(deps.db, unidentifiedPackageId),
    listUnidentifiedPackages: (facilityId) => listUnidentifiedReturnPackages(deps.db, facilityId),
    getIntakeMetrics: (facilityId) => getReturnIntakeMetrics(deps.db, facilityId),
    getEvidenceReference: (attachmentId, facilityId) =>
      getReturnIntakeEvidenceReference(deps.db, attachmentId, facilityId),
    completeFacilityIntake: async (input) => {
      try {
        return await commandHandler({
          streamId: returnShipmentStreamId(input.returnShipmentId),
          command: input.command,
          context: input.context,
          ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }),
        });
      } catch (error) {
        if ((error as { code?: string }).code !== "concurrency_conflict") {
          throw error;
        }
        const current = await repository.load(returnShipmentStreamId(input.returnShipmentId));
        if (current.state.facilityIntake === null) {
          throw error;
        }
        return commandHandler({
          streamId: returnShipmentStreamId(input.returnShipmentId),
          command: input.command,
          context: input.context,
          expectedVersion: current.version,
        });
      }
    },
    uploadEvidence: (input) =>
      storeReturnIntakeEvidence({
        ...input,
        storage: deps.evidenceStorage,
        securityScanner: deps.evidenceSecurityScanner,
      }),
    getEvidence: async (storageKey) => deps.evidenceStorage?.getObject(storageKey) ?? null,
    verifyEvidence: (facilityId, attachments) =>
      verifyStoredReturnIntakeEvidence({ facilityId, attachments, storage: deps.evidenceStorage }),
    processTrackingEvent: (event, context) =>
      processReturnShipmentTrackingEvent(
        { db: deps.db, commandHandler, streamIdFor: returnShipmentStreamId },
        event,
        context,
      ),
    projectors: [
      createProjectionHandlerSet({
        projectionName: FULFILLMENT_RETURN_SHIPMENT_PROJECTION,
        handlers: buildFulfillmentReturnShipmentProjectionHandlers(deps.db),
      }),
    ],
  };
}
