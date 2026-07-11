import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import type { EventStore } from "@chase-sets/event-core/event-store";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createId } from "@chase-sets/primitives/typed-ids";
import {
  buildCreatePolicyDocumentCommand,
  buildRevisePolicyDocumentCommand,
  type CreatePolicyDocumentParams,
  type RevisePolicyDocumentParams,
} from "./commands";
import { createPolicyCache, type PolicyCache } from "./cache";
import type { PolicyDefinition } from "./define-policy";
import {
  decidePolicyDocument,
  evolvePolicyDocument,
  initialPolicyDocumentState,
  PlatformPolicyDomainError,
  type PolicyDocumentCommand,
  type PolicyDocumentEvent,
  type PolicyDocumentState,
} from "./domain";
import { buildPolicyDocumentProjectionHandlers } from "./projection";
import {
  findOverlappingActivePolicyDocument,
  getPolicyDocument,
  listPolicyDocumentHistory,
  listPolicyRegistry,
} from "./queries";
import { createPolicyResolver, type ResolvedPolicy } from "./resolver";

/**
 * Policy document streams are keyed by document id under this fixed,
 * mechanism-level prefix -- deliberately NOT the mounting context's own
 * stream prefix (e.g. `commercial-terms.`), since one shared aggregate type
 * is reused by every context that adopts `definePolicy`. The generic
 * bounded-context-runtime auto-wires each unmapped `ProjectionHandlerSet`
 * into a "local projection subscription" that defaults its stream-prefix
 * filter to `${contextName}.` -- without declaring this prefix explicitly
 * below, that default would never match `platform-policy.document-*`
 * streams, and the projection would silently never catch up (a mounting
 * context's own read model would stay empty regardless of how many policy
 * documents are created).
 */
const POLICY_DOCUMENT_STREAM_PREFIX = "platform-policy.document-";

function policyDocumentStreamId(documentId: string): string {
  return `${POLICY_DOCUMENT_STREAM_PREFIX}${documentId}`;
}

export type PolicyRuntimeDeps = Readonly<{
  eventStore: EventStore;
  db: PgQueryable;
  cache?: PolicyCache;
  now?: () => Date;
}>;

export type PolicyRuntime = Readonly<{
  commandHandler: CommandHandler<PolicyDocumentCommand, PolicyDocumentState, PolicyDocumentEvent>;
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

/**
 * Composes the shared platform-policy machinery into one runtime: a context
 * mounts `projectors` alongside its own, and calls `createPolicyDocument` /
 * `revisePolicyDocument` / `resolvePolicy` from its own feature code. The
 * cache is shared between the projection handlers and the resolver so a
 * revision invalidates exactly the reads that depend on it.
 */
export function createPolicyRuntime(deps: PolicyRuntimeDeps): PolicyRuntime {
  const cache = deps.cache ?? createPolicyCache();
  const { commandHandler } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<PolicyDocumentEvent>(),
    initialState: () => initialPolicyDocumentState,
    evolve: evolvePolicyDocument,
    decide: decidePolicyDocument,
  });
  const resolver = createPolicyResolver({ db: deps.db, cache, now: deps.now });

  async function assertNoActiveOverlap(
    params: Readonly<{
      policyKey: string;
      status: string;
      effectiveFrom: string;
      effectiveUntil: string | null;
      excludeDocumentId?: string | null;
    }>,
  ) {
    if (params.status !== "active") {
      return;
    }

    const overlap = await findOverlappingActivePolicyDocument(deps.db, params);
    if (overlap) {
      throw new PlatformPolicyDomainError(
        `Active policy document ${overlap.document_id} already covers policy '${params.policyKey}' for that effective window.`,
      );
    }
  }

  return {
    commandHandler,
    async createPolicyDocument(definition, params, context) {
      const documentId = createId("pol");
      await assertNoActiveOverlap({
        policyKey: definition.policyKey,
        status: params.status,
        effectiveFrom: params.effectiveFrom,
        effectiveUntil: params.effectiveUntil,
      });
      const command = buildCreatePolicyDocumentCommand(definition, { ...params, documentId });
      const result = await commandHandler({
        streamId: policyDocumentStreamId(documentId),
        command,
        context,
      });
      return { documentId, version: result.version };
    },
    async revisePolicyDocument(definition, documentId, params, context) {
      await assertNoActiveOverlap({
        policyKey: definition.policyKey,
        status: params.status,
        effectiveFrom: params.effectiveFrom,
        effectiveUntil: params.effectiveUntil,
        excludeDocumentId: documentId,
      });
      const command = buildRevisePolicyDocumentCommand(definition, params);
      const result = await commandHandler({
        streamId: policyDocumentStreamId(documentId),
        command,
        context,
      });
      return { documentId, version: result.version };
    },
    resolvePolicy: resolver.resolvePolicy,
    getPolicyDocument: (documentId) => getPolicyDocument(deps.db, documentId),
    listPolicyDocumentHistory: (documentId) => listPolicyDocumentHistory(deps.db, documentId),
    listPolicyRegistry: () => listPolicyRegistry(deps.db),
    invalidateCache: cache.invalidate,
    projectors: [
      createProjectionHandlerSet({
        projectionName: "platform-policy-document-projection",
        handlers: buildPolicyDocumentProjectionHandlers(deps.db, { onPolicyRevised: cache.invalidate }),
        streamPrefixes: [POLICY_DOCUMENT_STREAM_PREFIX],
      }),
    ],
  };
}
