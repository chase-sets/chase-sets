import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { AggregateEvolver } from "@chase-sets/event-core/domain";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import type { EventStore } from "@chase-sets/event-core/event-store";
import {
  createProjectionHandlerSet,
  type ProjectionHandlerSet,
  type ProjectorHandlerMap,
} from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createId } from "@chase-sets/primitives/typed-ids";
import {
  buildCreatePolicyDocumentCommand,
  buildRevisePolicyDocumentCommand,
  type CreatePolicyDocumentParams,
  type RevisePolicyDocumentParams,
} from "@chase-sets/platform-policy/commands";
import { createPolicyCache, type PolicyCache } from "@chase-sets/platform-policy/cache";
import type { PolicyDefinition } from "@chase-sets/platform-policy/define-policy";
import {
  decidePolicyDocument,
  evolvePolicyDocument,
  initialPolicyDocumentState,
  PlatformPolicyDomainError,
  type PolicyDocumentCommand,
  type PolicyDocumentEvent,
  type PolicyDocumentState,
} from "@chase-sets/platform-policy/domain";
import { buildPolicyDocumentProjectionHandlers } from "@chase-sets/platform-policy/projection";
import {
  findOverlappingActivePolicyDocument,
  getPolicyDocument,
  listPolicyDocumentHistory,
  listPolicyRegistry,
} from "@chase-sets/platform-policy/queries";
import { createPolicyResolver, type ResolvedPolicy } from "@chase-sets/platform-policy/resolver";
import {
  type LegacyCommercialTermsPolicyEvent,
  upcastLegacyAgreementCreated,
  upcastLegacyAgreementRevised,
  upcastLegacyScheduleCreated,
  upcastLegacyScheduleRevised,
} from "./legacy-policy-events";
import {
  commercialTermsAgreementPolicyKey,
  commercialTermsSchedulePolicyKey,
  type CommercialTermsAgreementPolicyValue,
  type CommercialTermsSchedulePolicyValue,
} from "./terms-policy";

/**
 * The commercial-terms-wide policy runtime: one shared platform-policy
 * document aggregate/projection/resolver, adopted by every commercial-terms
 * policy family (checkout processing fee, schedules, agreements). Schedules
 * and agreements converged onto this, replacing their bespoke
 * aggregate/projection pair; the only thing that remains commercial-terms
 * domain code is the upcasting of their pre-convergence event shapes (see
 * `legacy-policy-events.ts`) and the stream-id/targeting conventions below.
 *
 * Checkout-processing-fee documents are keyed by a
 * machinery-generated document id on the standard
 * `platform-policy.document-<id>` stream. Schedules and agreements predate
 * the machinery: their existing event history lives on
 * `commercial-terms.schedule-<scheduleId>` / `commercial-terms.agreement-<agreementId>`
 * streams under the pre-convergence event types. Per the issue's event
 * compatibility constraint, that history is not rewritten or migrated onto
 * a new stream -- the aggregate keeps appending to those same streams, and
 * the shared evolver upcasts the legacy event shapes it finds there. New
 * schedules/agreements created after convergence still use the legacy-style
 * stream-id convention (scoped by scheduleId/agreementId) purely so
 * existing links, seed ids, and route paths keep working; every event they
 * ever emit is the shared `platform-policy.document.*` type.
 */

const POLICY_DOCUMENT_STREAM_PREFIX = "platform-policy.document-";
const SCHEDULE_STREAM_PREFIX = "commercial-terms.schedule-";
const AGREEMENT_STREAM_PREFIX = "commercial-terms.agreement-";

function policyDocumentStreamId(documentId: string): string {
  return `${POLICY_DOCUMENT_STREAM_PREFIX}${documentId}`;
}

export function scheduleStreamId(scheduleId: string): string {
  return `${SCHEDULE_STREAM_PREFIX}${scheduleId}`;
}

export function agreementStreamId(agreementId: string): string {
  return `${AGREEMENT_STREAM_PREFIX}${agreementId}`;
}

export type CommercialTermsPolicyDocumentEvent = PolicyDocumentEvent | LegacyCommercialTermsPolicyEvent;

/**
 * Dual-handler evolver: reduces both the shared `platform-policy.document.*`
 * event vocabulary and the four pre-convergence commercial-terms event
 * types onto the same generic `PolicyDocumentState`. Legacy "revised" events
 * do not carry the targeting field (accountType/accountId) -- it is only
 * ever stamped on "created" -- so the upcast pulls it forward from the
 * state accumulated so far in the fold, exactly as a normal revision would
 * carry forward whatever the aggregate already knows.
 */
export const evolveCommercialTermsPolicyDocument: AggregateEvolver<
  PolicyDocumentState,
  CommercialTermsPolicyDocumentEvent
> = (state, event) => {
  switch (event.type) {
    case "platform-policy.document.created":
    case "platform-policy.document.revised":
      return evolvePolicyDocument(state, event);
    case "commercial-terms.schedule.created":
      return evolvePolicyDocument(state, {
        type: "platform-policy.document.created",
        data: upcastLegacyScheduleCreated(event, ""),
      });
    case "commercial-terms.schedule.revised": {
      const priorValue = state.value as CommercialTermsSchedulePolicyValue;
      const priorPolicyKey = state.policyKey ?? commercialTermsSchedulePolicyKey(priorValue.accountType);
      return evolvePolicyDocument(state, {
        type: "platform-policy.document.revised",
        data: upcastLegacyScheduleRevised(event, priorValue, priorPolicyKey, ""),
      });
    }
    case "commercial-terms.agreement.created":
      return evolvePolicyDocument(state, {
        type: "platform-policy.document.created",
        data: upcastLegacyAgreementCreated(event, ""),
      });
    case "commercial-terms.agreement.revised": {
      const priorValue = state.value as CommercialTermsAgreementPolicyValue;
      const priorPolicyKey = state.policyKey ?? commercialTermsAgreementPolicyKey(priorValue.accountId);
      return evolvePolicyDocument(state, {
        type: "platform-policy.document.revised",
        data: upcastLegacyAgreementRevised(event, priorValue, priorPolicyKey, ""),
      });
    }
    default:
      throw new PlatformPolicyDomainError(`Unhandled commercial-terms policy event: ${JSON.stringify(event)}`);
  }
};

/**
 * Builds the projection handler map for every stream the commercial-terms
 * policy runtime owns. The two `platform-policy.document.*` handlers are
 * the shared machinery's own handlers, reused unmodified. The four legacy
 * handlers upcast at projection time and delegate into those same shared
 * handlers, so exactly one code path ever writes `platform_policy_documents`
 * / `platform_policy_document_history` rows.
 */
export function buildCommercialTermsPolicyProjectionHandlers(
  db: PgQueryable,
  options: Readonly<{ onPolicyRevised?: (policyKey: string) => void }> = {},
): ProjectorHandlerMap {
  const generic = buildPolicyDocumentProjectionHandlers(db, options);

  async function priorValue(documentId: string): Promise<Readonly<{ value: unknown; policyKey: string }> | null> {
    const result = await db.query<Readonly<{ value: unknown; policy_key: string }>>(
      `SELECT value, policy_key FROM platform_policy_documents WHERE document_id = $1`,
      [documentId],
    );
    const row = result.rows[0];
    return row ? { value: row.value, policyKey: row.policy_key } : null;
  }

  return {
    "platform-policy.document.created": generic["platform-policy.document.created"]!,
    "platform-policy.document.revised": generic["platform-policy.document.revised"]!,
    "commercial-terms.schedule.created": async (event) => {
      const data = upcastLegacyScheduleCreated(event as never, event.audit.performedByUserId);
      await generic["platform-policy.document.created"]!({
        ...event,
        type: "platform-policy.document.created",
        data,
      } as never);
    },
    "commercial-terms.schedule.revised": async (event) => {
      const scheduleId = (event.data as { scheduleId: string }).scheduleId;
      const prior = await priorValue(scheduleId);
      if (!prior) {
        throw new PlatformPolicyDomainError(
          `Cannot project a schedule revision for '${scheduleId}' before its creation has been projected.`,
        );
      }
      const data = upcastLegacyScheduleRevised(
        event as never,
        prior.value as CommercialTermsSchedulePolicyValue,
        prior.policyKey,
        event.audit.performedByUserId,
      );
      await generic["platform-policy.document.revised"]!({
        ...event,
        type: "platform-policy.document.revised",
        data,
      } as never);
    },
    "commercial-terms.agreement.created": async (event) => {
      const data = upcastLegacyAgreementCreated(event as never, event.audit.performedByUserId);
      await generic["platform-policy.document.created"]!({
        ...event,
        type: "platform-policy.document.created",
        data,
      } as never);
    },
    "commercial-terms.agreement.revised": async (event) => {
      const agreementId = (event.data as { agreementId: string }).agreementId;
      const prior = await priorValue(agreementId);
      if (!prior) {
        throw new PlatformPolicyDomainError(
          `Cannot project an agreement revision for '${agreementId}' before its creation has been projected.`,
        );
      }
      const data = upcastLegacyAgreementRevised(
        event as never,
        prior.value as CommercialTermsAgreementPolicyValue,
        prior.policyKey,
        event.audit.performedByUserId,
      );
      await generic["platform-policy.document.revised"]!({
        ...event,
        type: "platform-policy.document.revised",
        data,
      } as never);
    },
  };
}

export type CommercialTermsPolicyRuntimeDeps = Readonly<{
  eventStore: EventStore;
  db: PgQueryable;
  cache?: PolicyCache;
  now?: () => Date;
}>;

export type CommercialTermsPolicyRuntime = Readonly<{
  commandHandler: CommandHandler<PolicyDocumentCommand, PolicyDocumentState, CommercialTermsPolicyDocumentEvent>;
  createPolicyDocument: <Value>(
    definition: PolicyDefinition<Value>,
    params: Omit<CreatePolicyDocumentParams<Value>, "documentId">,
    context: EventStoreContext,
  ) => Promise<{ documentId: string; version: number }>;
  revisePolicyDocument: <Value>(
    definition: PolicyDefinition<Value>,
    documentId: string,
    params: RevisePolicyDocumentParams<Value>,
    context: EventStoreContext,
  ) => Promise<{ documentId: string; version: number }>;
  /** Creates a schedule document on its legacy-convention stream id (`commercial-terms.schedule-<scheduleId>`). */
  createScheduleDocument: (
    definition: PolicyDefinition<CommercialTermsSchedulePolicyValue>,
    params: Omit<CreatePolicyDocumentParams<CommercialTermsSchedulePolicyValue>, "documentId">,
    context: EventStoreContext,
  ) => Promise<{ scheduleId: string; version: number }>;
  reviseScheduleDocument: (
    definition: PolicyDefinition<CommercialTermsSchedulePolicyValue>,
    scheduleId: string,
    params: RevisePolicyDocumentParams<CommercialTermsSchedulePolicyValue>,
    context: EventStoreContext,
  ) => Promise<{ scheduleId: string; version: number }>;
  /** Creates an agreement document on its legacy-convention stream id (`commercial-terms.agreement-<agreementId>`). */
  createAgreementDocument: (
    definition: PolicyDefinition<CommercialTermsAgreementPolicyValue>,
    params: Omit<CreatePolicyDocumentParams<CommercialTermsAgreementPolicyValue>, "documentId">,
    context: EventStoreContext,
  ) => Promise<{ agreementId: string; version: number }>;
  reviseAgreementDocument: (
    definition: PolicyDefinition<CommercialTermsAgreementPolicyValue>,
    agreementId: string,
    params: RevisePolicyDocumentParams<CommercialTermsAgreementPolicyValue>,
    context: EventStoreContext,
  ) => Promise<{ agreementId: string; version: number }>;
  resolvePolicy: <Value>(
    definition: PolicyDefinition<Value>,
    params?: Readonly<{ at?: string }>,
  ) => Promise<ResolvedPolicy<Value>>;
  getPolicyDocument: (documentId: string) => ReturnType<typeof getPolicyDocument>;
  listPolicyDocumentHistory: (documentId: string) => ReturnType<typeof listPolicyDocumentHistory>;
  listPolicyRegistry: () => ReturnType<typeof listPolicyRegistry>;
  invalidateCache: (policyKey: string) => void;
  projectors: readonly ProjectionHandlerSet[];
}>;

async function assertNoActiveOverlap(
  db: PgQueryable,
  params: Readonly<{
    policyKey: string;
    status: string;
    effectiveFrom: string;
    effectiveUntil: string | null;
    excludeDocumentId?: string | null;
  }>,
  overlapMessage?: (overlapDocumentId: string) => string,
) {
  if (params.status !== "active") {
    return;
  }

  const overlap = await findOverlappingActivePolicyDocument(db, params);
  if (overlap) {
    throw new PlatformPolicyDomainError(
      overlapMessage?.(overlap.document_id) ??
        `Active policy document ${overlap.document_id} already covers policy '${params.policyKey}' for that effective window.`,
    );
  }
}

export function createCommercialTermsPolicyRuntime(
  deps: CommercialTermsPolicyRuntimeDeps,
): CommercialTermsPolicyRuntime {
  const cache = deps.cache ?? createPolicyCache();
  const { commandHandler } = createAggregateCommandHandler<
    PolicyDocumentState,
    PolicyDocumentCommand,
    CommercialTermsPolicyDocumentEvent
  >({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<CommercialTermsPolicyDocumentEvent>(),
    initialState: () => initialPolicyDocumentState,
    evolve: evolveCommercialTermsPolicyDocument,
    decide: decidePolicyDocument,
  });
  const resolver = createPolicyResolver({ db: deps.db, cache, now: deps.now });

  return {
    commandHandler,
    async createPolicyDocument(definition, params, context) {
      const documentId = createId("pol");
      await assertNoActiveOverlap(deps.db, {
        policyKey: definition.policyKey,
        status: params.status,
        effectiveFrom: params.effectiveFrom,
        effectiveUntil: params.effectiveUntil,
      });
      const command = buildCreatePolicyDocumentCommand(definition, { ...params, documentId });
      const result = await commandHandler({ streamId: policyDocumentStreamId(documentId), command, context });
      return { documentId, version: result.version };
    },
    async revisePolicyDocument(definition, documentId, params, context) {
      await assertNoActiveOverlap(deps.db, {
        policyKey: definition.policyKey,
        status: params.status,
        effectiveFrom: params.effectiveFrom,
        effectiveUntil: params.effectiveUntil,
        excludeDocumentId: documentId,
      });
      const command = buildRevisePolicyDocumentCommand(definition, params);
      const result = await commandHandler({ streamId: policyDocumentStreamId(documentId), command, context });
      return { documentId, version: result.version };
    },
    async createScheduleDocument(definition, params, context) {
      const scheduleId = createId("cts");
      await assertNoActiveOverlap(
        deps.db,
        {
          policyKey: definition.policyKey,
          status: params.status,
          effectiveFrom: params.effectiveFrom,
          effectiveUntil: params.effectiveUntil,
        },
        (overlapId) => `Active schedule ${overlapId} already covers that account type and effective window.`,
      );
      const command = buildCreatePolicyDocumentCommand(definition, { ...params, documentId: scheduleId });
      const result = await commandHandler({ streamId: scheduleStreamId(scheduleId), command, context });
      return { scheduleId, version: result.version };
    },
    async reviseScheduleDocument(definition, scheduleId, params, context) {
      await assertNoActiveOverlap(
        deps.db,
        {
          policyKey: definition.policyKey,
          status: params.status,
          effectiveFrom: params.effectiveFrom,
          effectiveUntil: params.effectiveUntil,
          excludeDocumentId: scheduleId,
        },
        (overlapId) => `Active schedule ${overlapId} already covers that account type and effective window.`,
      );
      const command = buildRevisePolicyDocumentCommand(definition, params);
      const result = await commandHandler({ streamId: scheduleStreamId(scheduleId), command, context });
      return { scheduleId, version: result.version };
    },
    async createAgreementDocument(definition, params, context) {
      const agreementId = createId("cag");
      await assertNoActiveOverlap(
        deps.db,
        {
          policyKey: definition.policyKey,
          status: params.status,
          effectiveFrom: params.effectiveFrom,
          effectiveUntil: params.effectiveUntil,
        },
        (overlapId) => `Active agreement ${overlapId} already covers that account and effective window.`,
      );
      const command = buildCreatePolicyDocumentCommand(definition, { ...params, documentId: agreementId });
      const result = await commandHandler({ streamId: agreementStreamId(agreementId), command, context });
      return { agreementId, version: result.version };
    },
    async reviseAgreementDocument(definition, agreementId, params, context) {
      await assertNoActiveOverlap(
        deps.db,
        {
          policyKey: definition.policyKey,
          status: params.status,
          effectiveFrom: params.effectiveFrom,
          effectiveUntil: params.effectiveUntil,
          excludeDocumentId: agreementId,
        },
        (overlapId) => `Active agreement ${overlapId} already covers that account and effective window.`,
      );
      const command = buildRevisePolicyDocumentCommand(definition, params);
      const result = await commandHandler({ streamId: agreementStreamId(agreementId), command, context });
      return { agreementId, version: result.version };
    },
    resolvePolicy: resolver.resolvePolicy,
    getPolicyDocument: (documentId) => getPolicyDocument(deps.db, documentId),
    listPolicyDocumentHistory: (documentId) => listPolicyDocumentHistory(deps.db, documentId),
    listPolicyRegistry: () => listPolicyRegistry(deps.db),
    invalidateCache: cache.invalidate,
    projectors: [
      createProjectionHandlerSet({
        projectionName: "platform-policy-document-projection",
        handlers: buildCommercialTermsPolicyProjectionHandlers(deps.db, { onPolicyRevised: cache.invalidate }),
        streamPrefixes: [POLICY_DOCUMENT_STREAM_PREFIX, SCHEDULE_STREAM_PREFIX, AGREEMENT_STREAM_PREFIX],
      }),
    ],
  };
}
