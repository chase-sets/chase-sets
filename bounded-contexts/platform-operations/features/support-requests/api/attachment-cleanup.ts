import { createHash } from "node:crypto";
import type { PrivateObjectStore } from "@chase-sets/object-storage";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext, StoredEvent } from "@chase-sets/event-core/storage";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { parseTypedId } from "@chase-sets/primitives/typed-ids";
import { SupportDomainError } from "../domain/common";
import {
  AttachmentOperationError,
  SUPPORT_EVIDENCE_ABANDONMENT_MS,
  SUPPORT_EVIDENCE_CLEANUP_PUT_GRACE_MS,
  attachmentManifestReferences,
  attachmentOperationStreamId,
  decideAttachmentOperation,
  hasUnsettledAttachmentPut,
  replayAttachmentOperation,
  type AttachmentOperationEvent,
  type AttachmentOperationState,
} from "../domain/attachment-operation";
import { attachmentStorageKey, SUPPORT_EVIDENCE_STORAGE_DEADLINE_MS } from "./attachments";
import { lastPutAdmittedAt, listSupportEvidenceCleanupCandidates } from "../read-model/cleanup-locator";
import { validateSupportAttachmentOperationId } from "./attachment-intake";
import type { createEvidenceAccessAudit } from "./evidence-access-audit";

export const SUPPORT_EVIDENCE_CLEANUP_BINDING_STREAM = "support.evidence-cleanup-binding";
export const SUPPORT_EVIDENCE_CLEANUP_RUNNER = "support-evidence-operation-cleanup";
export const SUPPORT_EVIDENCE_CLEANUP_MAX_OPERATIONS = 50;
const RECEIPT_EVENT = "support.evidence-cleanup-binding.recorded";
const SERVICE_USER = "usr_support_evidence_cleanup";
const SERVICE_ACCOUNT = "acc_support_evidence_cleanup";
const operationCodec = createPassthroughDomainEventCodec<AttachmentOperationEvent>();

export type SupportEvidenceCleanupBinding =
  | Readonly<{ kind: "denied"; diagnostic: "binding_absent" | "binding_invalid" | "binding_inactive" }>
  | Readonly<{
      kind: "configured";
      version: 1;
      environment: string;
      deploymentInstance: string;
      bindingId: string;
      revision: number;
      active: true;
      configDigest: string;
      implementationSha: string;
    }>;
export type ConfiguredSupportEvidenceCleanupBinding = Extract<SupportEvidenceCleanupBinding, { kind: "configured" }>;
/** Cleanup deletes and proves absence only; the binding never reaches put, read or listing. */
export type SupportEvidenceCleanupStorage = Pick<PrivateObjectStore, "deleteKeys" | "verifyPrivate">;
export type SupportEvidenceCleanupCapability =
  | Readonly<{ kind: "not-mounted" }>
  | Readonly<{
      kind: "available";
      binding: ConfiguredSupportEvidenceCleanupBinding;
      storage: SupportEvidenceCleanupStorage;
    }>;
export type SupportEvidenceCleanupRunResult = Readonly<{
  denied: "binding_receipt_stale" | "binding_unavailable" | null;
  examined: number;
  abandoned: number;
  claimed: number;
  deleted: number;
  failed: number;
  retainedUnsettled: number;
  withinGrace: number;
  referenced: number;
  invalid: number;
  conflicts: number;
  auditUnavailable: number;
}>;
export type SupportEvidenceCleanupRunner = (
  input?: Readonly<{ now?: Date; limit?: number }>,
) => Promise<SupportEvidenceCleanupRunResult>;

const environments = ["dev", "local", "remote-dev", "test", "preview", "staging", "production"];
const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

// The S-A2 release tuple: the same trusted instance identity scopes administration and cleanup.
function validInstance(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 170) return false;
  try {
    const tuple: unknown = JSON.parse(value);
    return (
      Array.isArray(tuple) &&
      tuple.length === 3 &&
      tuple[0] === "support-deployment-instance/v1" &&
      tuple.slice(1).every((part) => typeof part === "string" && dnsLabel.test(part)) &&
      JSON.stringify(tuple) === value
    );
  } catch {
    return false;
  }
}

export function parseSupportEvidenceCleanupBinding(
  raw: string | undefined,
  scope: Readonly<{
    environment: string;
    deploymentInstance: string | undefined;
    implementationSha: string | undefined;
  }>,
): SupportEvidenceCleanupBinding {
  if (!raw) return { kind: "denied", diagnostic: "binding_absent" };
  const invalid = { kind: "denied", diagnostic: "binding_invalid" } as const;
  if (
    Buffer.byteLength(raw, "utf8") > 1024 ||
    !validInstance(scope.deploymentInstance) ||
    !scope.implementationSha ||
    !/^[a-f0-9]{40}$/.test(scope.implementationSha)
  )
    return invalid;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return invalid;
    const fields = ["version", "environment", "deploymentInstance", "bindingId", "revision", "active"];
    if (Object.keys(value).length !== fields.length || !fields.every((key) => Object.hasOwn(value, key)))
      return invalid;
    const v = value as Record<string, unknown>;
    if (
      v.version !== 1 ||
      !environments.includes(String(v.environment)) ||
      v.environment !== scope.environment ||
      !validInstance(v.deploymentInstance) ||
      v.deploymentInstance !== scope.deploymentInstance ||
      typeof v.bindingId !== "string" ||
      !/^[a-z0-9-]{1,64}$/.test(v.bindingId) ||
      typeof v.revision !== "number" ||
      !Number.isInteger(v.revision) ||
      v.revision < 1 ||
      v.revision > 2147483647 ||
      typeof v.active !== "boolean"
    )
      return invalid;
    if (!v.active) return { kind: "denied", diagnostic: "binding_inactive" };
    // The digest covers the effective, scope-checked values rather than the raw declaration.
    const effective = {
      version: 1 as const,
      environment: scope.environment,
      deploymentInstance: scope.deploymentInstance,
      bindingId: v.bindingId,
      revision: v.revision,
      active: true as const,
    };
    return Object.freeze({
      kind: "configured",
      ...effective,
      configDigest: `sha256:${createHash("sha256").update(JSON.stringify(effective)).digest("hex")}`,
      implementationSha: scope.implementationSha,
    });
  } catch {
    return invalid;
  }
}

export function assertSupportEvidenceCleanupCapability(value: unknown): SupportEvidenceCleanupCapability {
  if (value === undefined) return { kind: "not-mounted" };
  if (!value || typeof value !== "object") throw new Error("Support evidence cleanup capability is malformed.");
  if ((value as { kind?: unknown }).kind === "not-mounted") return { kind: "not-mounted" };
  const capability = value as Partial<Extract<SupportEvidenceCleanupCapability, { kind: "available" }>>;
  if (
    capability.kind !== "available" ||
    capability.binding?.kind !== "configured" ||
    typeof capability.storage?.deleteKeys !== "function" ||
    typeof capability.storage.verifyPrivate !== "function"
  )
    throw new Error(
      "Support evidence cleanup capability must be 'available' with a configured binding or 'not-mounted'.",
    );
  const storage = capability.storage;
  return {
    kind: "available",
    binding: capability.binding,
    storage: { deleteKeys: (keys) => storage.deleteKeys(keys), verifyPrivate: (k, e) => storage.verifyPrivate(k, e) },
  };
}

type Receipt = Readonly<{ bindingId: string; revision: number; configDigest: string; version: number }>;
const serviceContext = (tenantId: string, accountId: string): EventStoreContext => ({
  tenantId: parseTypedId(tenantId, "tnt"),
  audit: { performedByUserId: parseTypedId(SERVICE_USER, "usr"), forAccountId: parseTypedId(accountId, "acc") },
});

/** S-A2's receipt fence applied to the cleanup binding: a monotonic, digest-checked compare-and-record. */
export function createSupportEvidenceCleanupBindingReceipt(
  eventStore: EventStore,
  binding: ConfiguredSupportEvidenceCleanupBinding,
) {
  async function current(): Promise<Receipt | null> {
    const events = await readCompleteStream(eventStore, {
      streamId: SUPPORT_EVIDENCE_CLEANUP_BINDING_STREAM,
      maxEvents: 10000,
    });
    let receipt: Receipt | null = null;
    for (const event of events) {
      const p = event.payload;
      if (
        event.eventType !== RECEIPT_EVENT ||
        Object.keys(p).length !== 4 ||
        typeof p.bindingId !== "string" ||
        !/^[a-z0-9-]{1,64}$/.test(p.bindingId) ||
        typeof p.revision !== "number" ||
        !Number.isInteger(p.revision) ||
        p.revision < 1 ||
        p.revision > 2147483647 ||
        typeof p.configDigest !== "string" ||
        !/^sha256:[a-f0-9]{64}$/.test(p.configDigest) ||
        typeof p.implementationSha !== "string" ||
        !/^[a-f0-9]{40}$/.test(p.implementationSha) ||
        (receipt && p.revision <= receipt.revision)
      )
        throw new SupportDomainError("cleanup_binding_history_invalid");
      receipt = {
        bindingId: p.bindingId,
        revision: p.revision,
        configDigest: p.configDigest,
        version: event.streamVersion,
      };
    }
    return receipt;
  }
  async function compareAndRecord(): Promise<Receipt> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const previous = await current();
      if (previous && previous.revision >= binding.revision) {
        if (previous.revision === binding.revision && previous.configDigest !== binding.configDigest)
          throw new SupportDomainError("cleanup_binding_digest_conflict");
        return previous;
      }
      try {
        const [event] = await eventStore.appendToStream({
          streamId: SUPPORT_EVIDENCE_CLEANUP_BINDING_STREAM,
          expectedVersion: previous?.version ?? "no_stream",
          context: serviceContext("tnt_identity", SERVICE_ACCOUNT),
          events: [
            {
              eventType: RECEIPT_EVENT,
              payload: {
                bindingId: binding.bindingId,
                revision: binding.revision,
                configDigest: binding.configDigest,
                implementationSha: binding.implementationSha,
              },
            },
          ],
        });
        return { ...binding, version: event!.streamVersion };
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "concurrency_conflict")) throw error;
      }
    }
    throw new SupportDomainError("cleanup_binding_unavailable");
  }
  let initialization: Promise<Receipt> | undefined;
  // Only a recorded receipt is memoized; a transient boot failure is retried by the next run.
  const initialize = () =>
    (initialization ??= compareAndRecord().catch((error: unknown) => {
      initialization = undefined;
      throw error;
    }));
  return {
    initialize,
    /** The receipt this process may act under, or null when a newer revision or another digest superseded it. */
    admitted: async (): Promise<Receipt | null> => {
      await initialize();
      const receipt = await current();
      return receipt &&
        receipt.bindingId === binding.bindingId &&
        receipt.revision === binding.revision &&
        receipt.configDigest === binding.configDigest
        ? receipt
        : null;
    },
  };
}

// --- Authoritative operation and case reads shared by the human request and the runner. ---

async function loadOperation(eventStore: EventStore, supportRequestId: string, operationId: string) {
  const streamId = attachmentOperationStreamId({ supportRequestId, operationId });
  const history = await readCompleteStream(eventStore, { streamId });
  if (!history.length) return null;
  const state = replayAttachmentOperation(history.map(operationCodec.decode));
  const owner = state.manifest?.owner;
  if (
    !owner ||
    owner.supportRequestId !== supportRequestId ||
    owner.operationId !== operationId ||
    history.some((event) => event.tenantId !== owner.tenantId || event.forAccountId !== owner.accountId)
  )
    return null;
  return { streamId, history, state, owner, version: history.at(-1)!.streamVersion };
}

function operationAppend(
  loaded: NonNullable<Awaited<ReturnType<typeof loadOperation>>>,
  events: readonly AttachmentOperationEvent[],
  performedByUserId: string,
) {
  return {
    streamId: loaded.streamId,
    expectedVersion: loaded.version,
    context: {
      tenantId: parseTypedId(loaded.owner.tenantId, "tnt"),
      audit: {
        performedByUserId: parseTypedId(performedByUserId, "usr"),
        forAccountId: parseTypedId(loaded.owner.accountId, "acc"),
      },
    },
    events: events.map(operationCodec.encode),
  };
}

/** Records a human CleanupRequired. It never claims, deletes or touches storage. */
export async function requestSupportAttachmentCleanup(
  eventStore: EventStore,
  input: Readonly<{ supportRequestId: string; operationId: string; performedByUserId: string }>,
): Promise<Readonly<{ operationId: string; status: AttachmentOperationState["status"] }>> {
  validateSupportAttachmentOperationId(input.operationId);
  const loaded = await loadOperation(eventStore, input.supportRequestId, input.operationId).catch((error) => {
    if (error instanceof AttachmentOperationError) return null;
    throw error;
  });
  if (!loaded) throw new SupportDomainError("attachment_operation_unknown");
  let events: readonly AttachmentOperationEvent[];
  try {
    events = decideAttachmentOperation(loaded.state, {
      type: "RequireSupportAttachmentCleanup",
      data: { reason: "human-request" },
    });
  } catch (error) {
    if (error instanceof AttachmentOperationError && error.code === "operation-terminal")
      throw new SupportDomainError("attachment_operation_referenced");
    throw error;
  }
  if (events.length) await eventStore.appendToStream(operationAppend(loaded, events, input.performedByUserId));
  const status = replayAttachmentOperation([...loaded.history.map(operationCodec.decode), ...events]).status;
  return { operationId: input.operationId, status };
}

const caseStream = (supportRequestId: string) => `support.support-request-${supportRequestId}`;
function caseReferences(history: readonly StoredEvent[]): ReadonlySet<string> {
  const references = new Set<string>();
  for (const event of history) {
    if (event.eventType !== "support.support-request.evidence-submitted") continue;
    const evidence = event.payload.evidence;
    if (!evidence || typeof evidence !== "object" || Array.isArray(evidence))
      throw new SupportDomainError("attachment_reference_history_unavailable");
    const attachments = (evidence as Record<string, unknown>).attachments;
    if (!Array.isArray(attachments) || attachments.some((reference) => typeof reference !== "string"))
      throw new SupportDomainError("attachment_reference_history_unavailable");
    for (const reference of attachments) references.add(reference as string);
  }
  return references;
}

// --- The leased runner. ---

export function createSupportEvidenceCleanupRunner(
  deps: Readonly<{
    eventStore: EventStore;
    db: PgQueryable;
    capability: Extract<SupportEvidenceCleanupCapability, { kind: "available" }>;
    audit: Pick<ReturnType<typeof createEvidenceAccessAudit>, "recordService">;
    listCandidates?: typeof listSupportEvidenceCleanupCandidates;
  }>,
): Readonly<{ initialize: () => Promise<unknown>; run: SupportEvidenceCleanupRunner }> {
  const { eventStore, capability } = deps;
  const { binding, storage } = capability;
  const receipts = createSupportEvidenceCleanupBindingReceipt(eventStore, binding);
  const listCandidates = deps.listCandidates ?? listSupportEvidenceCleanupCandidates;
  if (!eventStore.appendToStreams) throw new Error("Support evidence cleanup requires atomic multi-stream appends.");
  const appendToStreams = eventStore.appendToStreams;

  const run: SupportEvidenceCleanupRunner = async (input = {}) => {
    const now = input.now ?? new Date();
    const limit = Math.max(
      1,
      Math.min(input.limit ?? SUPPORT_EVIDENCE_CLEANUP_MAX_OPERATIONS, SUPPORT_EVIDENCE_CLEANUP_MAX_OPERATIONS),
    );
    const counts = {
      examined: 0,
      abandoned: 0,
      claimed: 0,
      deleted: 0,
      failed: 0,
      retainedUnsettled: 0,
      withinGrace: 0,
      referenced: 0,
      invalid: 0,
      conflicts: 0,
      auditUnavailable: 0,
    };
    let receipt: Receipt | null;
    try {
      receipt = await receipts.admitted();
    } catch {
      return { denied: "binding_unavailable", ...counts };
    }
    if (!receipt) return { denied: "binding_receipt_stale", ...counts };
    for (const candidate of await listCandidates(deps.db, { now, limit })) {
      counts.examined++;
      try {
        const outcome = await cleanOne(candidate, receipt, now);
        if (outcome.abandoned) counts.abandoned++;
        counts[outcome.result]++;
        if (outcome.result === "deleted" || outcome.result === "failed") counts.claimed++;
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "concurrency_conflict") counts.conflicts++;
        else throw error;
      }
    }
    return { denied: null, ...counts };
  };

  type Outcome = Readonly<{
    abandoned: boolean;
    result: "deleted" | "failed" | "retainedUnsettled" | "withinGrace" | "referenced" | "invalid" | "auditUnavailable";
  }>;
  async function cleanOne(
    candidate: Readonly<{ supportRequestId: string; operationId: string }>,
    receipt: Receipt,
    now: Date,
  ): Promise<Outcome> {
    // A poisoned history is retained, never repaired; database failures propagate and end the run without deletes.
    const load = () =>
      loadOperation(eventStore, candidate.supportRequestId, candidate.operationId).catch((error) => {
        if (error instanceof AttachmentOperationError) return null;
        throw error;
      });
    let loaded = await load();
    let abandoned = false;
    const retained = (result: Outcome["result"]): Outcome => ({ abandoned, result });
    if (!loaded) return retained("invalid");
    if (hasUnsettledAttachmentPut(loaded.state)) return retained("retainedUnsettled");
    if (["staged", "partially-stored", "stored"].includes(loaded.state.status)) {
      if (now.getTime() < Date.parse(loaded.history.at(-1)!.recordedAt) + SUPPORT_EVIDENCE_ABANDONMENT_MS)
        return retained("withinGrace");
      const events = decideAttachmentOperation(loaded.state, {
        type: "RequireSupportAttachmentCleanup",
        data: { reason: "abandoned" },
      });
      await eventStore.appendToStream(operationAppend(loaded, events, SERVICE_USER));
      abandoned = true;
      loaded = await load();
      if (!loaded) return retained("invalid");
    }
    if (loaded.state.status === "reference-claimed" || loaded.state.status === "referenced")
      return retained("referenced");
    if (loaded.state.status !== "cleanup-required" && loaded.state.status !== "cleanup-claimed")
      return retained("invalid");
    const lastPut = lastPutAdmittedAt(loaded.history);
    if (lastPut && now.getTime() < Date.parse(lastPut) + SUPPORT_EVIDENCE_CLEANUP_PUT_GRACE_MS)
      return retained("withinGrace");

    // One durable service attempt precedes the bounded operational audit read (operation lifecycle and the
    // complete case history, never bytes); without it nothing further is read and no provider work happens.
    try {
      await deps.audit.recordService(
        candidate.supportRequestId,
        loaded.owner.tenantId,
        { bindingId: binding.bindingId, revision: binding.revision },
        "allowed",
      );
    } catch {
      return retained("auditUnavailable");
    }
    const caseHistory = await readCompleteStream(eventStore, { streamId: caseStream(candidate.supportRequestId) });
    let references: ReadonlySet<string>;
    try {
      references = caseReferences(caseHistory);
    } catch {
      return retained("invalid");
    }
    if (attachmentManifestReferences(loaded.state.manifest!).some((reference) => references.has(reference)))
      return retained("referenced");

    const claimedAt = now.toISOString();
    const command = {
      type: "ClaimSupportAttachmentCleanup" as const,
      data: {
        attempt: loaded.state.cleanupAttempts + 1,
        manifestFingerprint: loaded.state.manifest!.manifestFingerprint,
        bindingId: binding.bindingId,
        bindingRevision: binding.revision,
        claimedAt,
      },
    };
    const claimEvents = decideAttachmentOperation(loaded.state, command, {
      bindingId: binding.bindingId,
      bindingRevision: binding.revision,
      now: claimedAt,
      lastPutAdmittedAt: lastPut,
    });
    const guardContext = serviceContext(loaded.owner.tenantId, loaded.owner.accountId);
    // Operation version, complete case read and the observed binding receipt all fence the claim atomically.
    await appendToStreams([
      operationAppend(loaded, claimEvents, SERVICE_USER),
      {
        streamId: caseStream(candidate.supportRequestId),
        expectedVersion: caseHistory.at(-1)?.streamVersion ?? 0,
        context: guardContext,
        events: [],
      },
      {
        streamId: SUPPORT_EVIDENCE_CLEANUP_BINDING_STREAM,
        expectedVersion: receipt.version,
        context: guardContext,
        events: [],
      },
    ]);
    const claimed = {
      ...loaded,
      state: replayAttachmentOperation([...loaded.history.map(operationCodec.decode), ...claimEvents]),
      version: loaded.version + claimEvents.length,
    };
    const items = loaded.state.manifest!.items;
    const keys = items.map((item) =>
      attachmentStorageKey(candidate.supportRequestId, item.attachmentId, item.canonicalSha256, item.contentType),
    );
    const outcomes = await storage.deleteKeys(keys).catch(() => null);
    let failure: "delete-failed" | "confirm-failed" | null =
      outcomes &&
      outcomes.length === keys.length &&
      keys.every((key) => outcomes.some((o) => o.key === key && (o.status === "deleted" || o.status === "absent")))
        ? null
        : "delete-failed";
    if (!failure) {
      const reads = await Promise.all(
        items.map((item, index) =>
          storage
            .verifyPrivate(keys[index]!, {
              sha256: item.canonicalSha256,
              byteSize: item.byteSize,
              contentType: item.contentType,
              deadlineMs: SUPPORT_EVIDENCE_STORAGE_DEADLINE_MS,
            })
            .catch(() => null),
        ),
      );
      if (!reads.every((read) => read?.status === "absent")) failure = "confirm-failed";
    }
    const attempt = command.data.attempt;
    const outcomeEvents = decideAttachmentOperation(
      claimed.state,
      failure
        ? { type: "RecordSupportAttachmentCleanupFailed", data: { attempt, reason: failure } }
        : { type: "ConfirmSupportAttachmentDeleted", data: { attempt } },
    );
    await eventStore.appendToStream(operationAppend(claimed, outcomeEvents, SERVICE_USER));
    return { abandoned, result: failure ? "failed" : "deleted" };
  }

  return { initialize: receipts.initialize, run };
}
