import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import {
  decideAuthenticityCase,
  evolveAuthenticityCase,
  initialAuthenticityCaseState,
  type AuthenticityCaseCommand,
  type AuthenticityCaseEvent,
  type AuthenticityCaseState,
} from "../domain/domain";
import { buildAuthenticityCaseProjectionHandlers } from "../read-model/projection";
import {
  getAuthenticityCase,
  getAuthenticityCaseByOrderId,
  listAuthenticityOperatorQueue,
  type AuthenticityOperatorQueueFilter,
} from "../read-model/queries";
import { AuthenticityDomainError } from "../../../support/runtime-support/common";
import type { AuthenticityRuntimeDeps } from "../../../support/runtime-support";
import type {
  AuthenticityCaseId,
  AuthenticityChecklistResult,
  AuthenticityOrderLineNote,
  AuthenticityOrderSnapshotRef,
  AuthenticityPlanRef,
  AuthenticityVerdict,
  AuthenticityVerdictReasonCode,
} from "../../../support/runtime-support/common";

export type OpenAuthenticityCaseParams = Readonly<{
  caseId?: AuthenticityCaseId | null;
  orderId: string;
  sellerAccountId: AccountId;
  buyerAccountId: AccountId;
  orderSnapshot: AuthenticityOrderSnapshotRef;
  authenticityPlan: AuthenticityPlanRef;
  openedAt?: string;
}>;

export type RecordAuthenticityVerdictParams = Readonly<{
  caseId: string;
  verdict: AuthenticityVerdict;
  reasonCodes: readonly AuthenticityVerdictReasonCode[];
  checklistResults: readonly AuthenticityChecklistResult[];
  evidencePhotoRefs: readonly string[];
  lineNotes?: readonly AuthenticityOrderLineNote[];
  inspectorAccountId: string;
}>;

export type AuthenticityCaseServices = Readonly<{
  commandHandler: CommandHandler<AuthenticityCaseCommand, AuthenticityCaseState, AuthenticityCaseEvent>;
  openCase: (
    params: OpenAuthenticityCaseParams,
    context: EventStoreContext,
  ) => Promise<{ caseId: string; version: number }>;
  recordInboundTracking: (
    params: Readonly<{ caseId: string; inboundTrackingIdentifier: string }>,
    context: EventStoreContext,
  ) => Promise<{ caseId: string; version: number }>;
  receiveCase: (
    params: Readonly<{ caseId: string }>,
    context: EventStoreContext,
  ) => Promise<{ caseId: string; version: number }>;
  beginInspection: (
    params: Readonly<{ caseId: string; inspectorAccountId: string }>,
    context: EventStoreContext,
  ) => Promise<{ caseId: string; version: number }>;
  recordVerdict: (
    params: RecordAuthenticityVerdictParams,
    context: EventStoreContext,
  ) => Promise<{ caseId: string; version: number }>;
  forwardCase: (
    params: Readonly<{ caseId: string; outboundTrackingIdentifier?: string | null }>,
    context: EventStoreContext,
  ) => Promise<{ caseId: string; version: number }>;
  returnCase: (
    params: Readonly<{ caseId: string; returnReason?: string | null }>,
    context: EventStoreContext,
  ) => Promise<{ caseId: string; version: number }>;
  getCase: (caseId: string) => ReturnType<typeof getAuthenticityCase>;
  getCaseByOrderId: (orderId: string) => ReturnType<typeof getAuthenticityCaseByOrderId>;
  listOperatorQueue: (filter?: AuthenticityOperatorQueueFilter) => ReturnType<typeof listAuthenticityOperatorQueue>;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createAuthenticityCaseRuntime(deps: AuthenticityRuntimeDeps): AuthenticityCaseServices {
  const codec = createPassthroughDomainEventCodec<AuthenticityCaseEvent>();
  const { commandHandler, repository } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec,
    initialState: () => initialAuthenticityCaseState,
    evolve: evolveAuthenticityCase,
    decide: decideAuthenticityCase,
  });

  const streamId = (caseId: string) => `authenticity.case-${caseId}`;

  return {
    commandHandler,
    openCase: async (params, context) => {
      const caseId = params.caseId ?? (createId("case") as AuthenticityCaseId);
      const existing = await repository.load(streamId(caseId));
      if (existing.state.id !== null) {
        if (existing.state.orderId === params.orderId) {
          return { caseId, version: existing.version };
        }
        throw new AuthenticityDomainError("Authenticity case already exists for a different order.");
      }

      const result = await commandHandler({
        streamId: streamId(caseId),
        command: {
          type: "OpenAuthenticityCase",
          caseId,
          orderId: params.orderId,
          sellerAccountId: params.sellerAccountId,
          buyerAccountId: params.buyerAccountId,
          orderSnapshot: params.orderSnapshot,
          authenticityPlan: params.authenticityPlan,
          openedAt: params.openedAt ?? new Date().toISOString(),
        },
        context,
      });

      return { caseId, version: result.version };
    },
    recordInboundTracking: async (params, context) => {
      const result = await commandHandler({
        streamId: streamId(params.caseId),
        command: {
          type: "RecordAuthenticityInboundTracking",
          inboundTrackingIdentifier: params.inboundTrackingIdentifier,
          recordedAt: new Date().toISOString(),
        },
        context,
      });
      return { caseId: params.caseId, version: result.version };
    },
    receiveCase: async (params, context) => {
      const result = await commandHandler({
        streamId: streamId(params.caseId),
        command: {
          type: "ReceiveAuthenticityCase",
          receivedAt: new Date().toISOString(),
        },
        context,
      });
      return { caseId: params.caseId, version: result.version };
    },
    beginInspection: async (params, context) => {
      const result = await commandHandler({
        streamId: streamId(params.caseId),
        command: {
          type: "BeginAuthenticityInspection",
          inspectorAccountId: params.inspectorAccountId,
          startedAt: new Date().toISOString(),
        },
        context,
      });
      return { caseId: params.caseId, version: result.version };
    },
    recordVerdict: async (params, context) => {
      const result = await commandHandler({
        streamId: streamId(params.caseId),
        command: {
          type: "RecordAuthenticityVerdict",
          verdict: params.verdict,
          reasonCodes: params.reasonCodes,
          checklistResults: params.checklistResults,
          evidencePhotoRefs: params.evidencePhotoRefs,
          lineNotes: params.lineNotes,
          inspectorAccountId: params.inspectorAccountId,
          decidedAt: new Date().toISOString(),
        },
        context,
      });
      return { caseId: params.caseId, version: result.version };
    },
    forwardCase: async (params, context) => {
      const result = await commandHandler({
        streamId: streamId(params.caseId),
        command: {
          type: "ForwardAuthenticityCase",
          forwardedAt: new Date().toISOString(),
          outboundTrackingIdentifier: params.outboundTrackingIdentifier ?? null,
        },
        context,
      });
      return { caseId: params.caseId, version: result.version };
    },
    returnCase: async (params, context) => {
      const result = await commandHandler({
        streamId: streamId(params.caseId),
        command: {
          type: "ReturnAuthenticityCase",
          returnedAt: new Date().toISOString(),
          returnReason: params.returnReason ?? null,
        },
        context,
      });
      return { caseId: params.caseId, version: result.version };
    },
    getCase: (caseId) => getAuthenticityCase(deps.db, caseId),
    getCaseByOrderId: (orderId) => getAuthenticityCaseByOrderId(deps.db, orderId),
    listOperatorQueue: (filter) => listAuthenticityOperatorQueue(deps.db, filter),
    projectors: [
      createProjectionHandlerSet({
        projectionName: "authenticity-case-projection",
        handlers: buildAuthenticityCaseProjectionHandlers(deps.db),
      }),
    ],
  };
}
