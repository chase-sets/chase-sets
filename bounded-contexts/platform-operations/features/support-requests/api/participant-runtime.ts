import { createHash } from "node:crypto";
import { t } from "@chase-sets/localization";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import { recordCommittedEvents } from "@chase-sets/event-core/consistency";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { ResolvedActor } from "@chase-sets/auth-context";
import type { EventStoreContext, StoredEvent } from "@chase-sets/event-core/storage";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { AccountId, SupportRequestId } from "@chase-sets/primitives/typed-ids";
import type {
  SupportEvidenceType,
  SupportFlowType,
  SupportResolutionType,
  SupportResponseType,
  SupportEvidenceReferenceAuthority,
} from "../domain/common";
import {
  canonicalParticipantRequest,
  closedObject,
  parseParticipantAttempt,
  parseParticipantLookup,
  participantActions,
  ParticipantAttemptError,
  type ParticipantAction,
  type ParticipantAttempt,
  type ParticipantLookup,
  type ParticipantResult,
  type ParticipantReceipt,
} from "../domain/participant-attempt";
import {
  decideSupportRequest,
  evolveSupportRequest,
  expectedOfferResolution,
  initialSupportRequestState,
  type OpenSupportRequestCommand,
  type SupportRequestCommand,
  type SupportRequestEvent,
  type SupportRequestState,
  type SubmitSupportEvidenceCommand,
} from "../domain/domain";

export const PARTICIPANT_RECEIPT_EVENT = "support.support-request.participant-attempt-recorded";
export type ParticipantCommandInput = Readonly<{
  actionKind: ParticipantAction;
  attempt: ParticipantAttempt;
  targetId?: string;
  body: unknown;
  accountId: string;
  actor?: ResolvedActor;
}>;
export type ParticipantLookupInput = Readonly<{
  actionKind: ParticipantAction;
  attempt: ParticipantAttempt;
  targetId?: string;
  accountId: string;
  tenantId: string;
}>;
export type PrepareSupportEvidence = (
  command: SubmitSupportEvidenceCommand,
  state: SupportRequestState,
  caseVersion: number,
  context: EventStoreContext,
) => Promise<
  Readonly<{
    command: SubmitSupportEvidenceCommand;
    authority: SupportEvidenceReferenceAuthority;
    append: EventStore["appendToStream"];
    confirm: () => Promise<void>;
  }>
>;
type Deps = Readonly<{
  eventStore: EventStore;
  prepareEvidence: PrepareSupportEvidence;
  prepareOpen: (
    body: ReturnType<typeof payload>,
    accountId: string,
    id: SupportRequestId,
    context: EventStoreContext,
  ) => Promise<OpenSupportRequestCommand>;
  isReflected: (facts: readonly StoredEvent[]) => Promise<boolean>;
  authorizeEvidence?: (targetId: string, actor: ResolvedActor | null) => Promise<unknown>;
  now?: () => string;
}>;
function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stable(object[key])}`)
    .join(",")}}`;
}
function factsHash(events: readonly Pick<StoredEvent, "eventType" | "payload">[]) {
  return digest(stable(events.map(({ eventType, payload }) => ({ eventType, payload }))));
}
type NormalizedPayload = Readonly<{
  orderId: string;
  flowType: SupportFlowType;
  affectedLineIds: readonly string[] | null;
  submittedByRole: string | null;
  evidenceType: SupportEvidenceType;
  summary: string;
  occurredAt: string | null;
  attachments: readonly string[];
  intakePhotoReferences: readonly string[];
  attachmentOperationId?: string;
  responseType: SupportResponseType;
  offerResolutionType: SupportResolutionType | null;
  refundAmount: string | null;
  refundCurrencyCode: string | null;
  offerId: string;
  reason: string;
}>;
function payload(canonical: string): NormalizedPayload {
  const value = JSON.parse(canonical).payload as Partial<NormalizedPayload>;
  return { ...value, intakePhotoReferences: value.intakePhotoReferences ?? [] } as NormalizedPayload;
}
export function participantOpenSupportRequestId(
  tenantId: string,
  accountId: string,
  attemptId: string,
): SupportRequestId {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let bits = BigInt(`0x${digest(JSON.stringify([tenantId, accountId, attemptId])).slice(0, 32)}`);
  let ulid = "";
  for (let index = 0; index < 26; index++) {
    ulid = alphabet[Number(bits & 31n)] + ulid;
    bits >>= 5n;
  }
  return `sup_${ulid}`;
}
function target(input: ParticipantLookupInput): string {
  const id =
    input.actionKind === "open-support-request"
      ? participantOpenSupportRequestId(input.tenantId, input.accountId, input.attempt.attemptId)
      : input.targetId;
  if (!id || !/^sup_[A-Za-z0-9_-]{1,80}$/.test(id))
    throw new ParticipantAttemptError(400, "invalid-participant-target");
  return id;
}
function participant(state: SupportRequestState, accountId: string): "buyer" | "seller" {
  if (state.buyerAccountId === accountId) return "buyer";
  if (state.sellerAccountId === accountId) return "seller";
  throw new ParticipantAttemptError(403, "support-request-unavailable");
}
function sameOwner(receipt: ParticipantReceipt, input: ParticipantLookupInput, id: string) {
  return (
    receipt.tenantId === input.tenantId &&
    receipt.accountId === input.accountId &&
    receipt.targetId === id &&
    receipt.attemptId === input.attempt.attemptId
  );
}
function result(
  actionKind: ParticipantAction,
  id: string,
  version: number,
  events: readonly SupportRequestEvent[],
): ParticipantResult {
  const evidence = events.find((event) => event.type === "support.support-request.evidence-submitted");
  const response = events.find((event) => event.type === "support.support-request.response-recorded");
  return {
    id,
    version,
    status: participantActions[actionKind].status,
    evidenceId:
      evidence?.type === "support.support-request.evidence-submitted" ? evidence.data.evidence.evidenceId : null,
    responseId:
      response?.type === "support.support-request.response-recorded" ? response.data.response.responseId : null,
    offerId:
      response?.type === "support.support-request.response-recorded" ? (response.data.offer?.offerId ?? null) : null,
  };
}
function parseReceipt(value: unknown): ParticipantReceipt {
  const b = closedObject(value, [
    "tenantId",
    "accountId",
    "targetId",
    "attemptId",
    "requestHash",
    "actionKind",
    "firstVersion",
    "factsHash",
    "result",
  ]);
  if (
    Object.keys(b).length !== 9 ||
    typeof b.tenantId !== "string" ||
    !/^tnt_[A-Za-z0-9_-]{1,80}$/.test(b.tenantId) ||
    typeof b.accountId !== "string" ||
    !/^acc_[A-Za-z0-9_-]{1,80}$/.test(b.accountId) ||
    typeof b.firstVersion !== "number" ||
    !Number.isSafeInteger(b.firstVersion) ||
    b.firstVersion < 1 ||
    typeof b.factsHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(b.factsHash)
  )
    throw new Error("Invalid receipt");
  parseParticipantAttempt({ attemptId: b.attemptId, requestHash: b.requestHash });
  const lookup = parseParticipantLookup({ outcome: "committed", actionKind: b.actionKind, result: b.result });
  if (lookup.outcome !== "committed" || lookup.result.id !== b.targetId) throw new Error("Invalid receipt target");
  return b as ParticipantReceipt;
}

export function validateParticipantHistory(events: readonly StoredEvent[], id: string) {
  let state = initialSupportRequestState;
  const receipts: { receipt: ParticipantReceipt; facts: readonly StoredEvent[] }[] = [];
  const keys = new Set<string>();
  let pending: StoredEvent[] = [];
  const codec = createPassthroughDomainEventCodec<SupportRequestEvent>();
  for (const event of events) {
    if (event.eventType === PARTICIPANT_RECEIPT_EVENT) {
      const receipt = parseReceipt(event.payload);
      const key = JSON.stringify([receipt.tenantId, receipt.accountId, receipt.targetId, receipt.attemptId]);
      const first = pending[0];
      if (
        !first ||
        receipt.targetId !== id ||
        event.tenantId !== receipt.tenantId ||
        event.forAccountId !== receipt.accountId ||
        receipt.firstVersion !== first.streamVersion ||
        receipt.result.version !== event.streamVersion ||
        keys.has(key) ||
        !pending.some((fact) => fact.eventType === participantActions[receipt.actionKind].fact) ||
        receipt.factsHash !== factsHash(pending) ||
        pending.some(
          (fact) =>
            fact.tenantId !== receipt.tenantId ||
            fact.forAccountId !== receipt.accountId ||
            stable(fact.metadata.participantAttempt) !==
              stable({
                attemptId: receipt.attemptId,
                requestHash: receipt.requestHash,
                actionKind: receipt.actionKind,
                targetId: id,
              }),
        )
      )
        throw new Error("Unpaired or inconsistent receipt");
      const expected = result(
        receipt.actionKind,
        id,
        event.streamVersion,
        pending.map((fact) => codec.decode(fact)),
      );
      if (stable(expected) !== stable(receipt.result)) throw new Error("Changed receipt result");
      const primary = pending.find((fact) => fact.eventType === participantActions[receipt.actionKind].fact)!;
      let factActor: unknown;
      switch (receipt.actionKind) {
        case "open-support-request":
          if (id !== participantOpenSupportRequestId(receipt.tenantId, receipt.accountId, receipt.attemptId))
            throw new Error("Changed open owner");
          factActor = primary.payload.openedByAccountId;
          break;
        case "submit-evidence":
          factActor = (primary.payload.evidence as { submittedByAccountId?: unknown })?.submittedByAccountId;
          break;
        case "record-response":
          factActor = (primary.payload.response as { submittedByAccountId?: unknown })?.submittedByAccountId;
          break;
        case "accept-offer":
        case "decline-offer":
          factActor = (primary.payload.offer as { decidedByAccountId?: unknown })?.decidedByAccountId;
          break;
        case "escalate":
          factActor = primary.payload.escalatedByAccountId;
          break;
        case "cancel":
          factActor = state.openedByAccountId;
          break;
        case "return-condition-dispute":
          factActor = primary.payload.disputedByAccountId;
          break;
        case "close":
          factActor = receipt.accountId;
          break;
      }
      if (factActor !== receipt.accountId) throw new Error("Changed participant fact owner");
      keys.add(key);
      receipts.push({ receipt, facts: pending });
      pending = [];
      continue;
    }
    if (pending.length && !event.metadata.participantAttempt) throw new Error("Business-only attempt");
    const eventTarget =
      event.eventType === "platform-operations.csat-outcome-fact.v1"
        ? (event.payload.subject as { entityId?: unknown } | undefined)?.entityId
        : event.payload.supportRequestId;
    if (
      eventTarget !== id ||
      (state.supportRequestId === null && event.eventType !== "support.support-request.opened") ||
      (state.supportRequestId !== null && event.eventType === "support.support-request.opened")
    )
      throw new Error("Invalid history target or lifecycle");
    if (event.metadata.participantAttempt) {
      if (!pending.length && (state.status === "closed" || state.status === "cancelled"))
        throw new Error("Post-terminal attempt");
      pending.push(event);
    }
    state = evolveSupportRequest(state, codec.decode(event));
  }
  if (pending.length) throw new Error("Business-only attempt");
  return { state, receipts, version: events.at(-1)?.streamVersion ?? 0 };
}

export function createParticipantRuntime(deps: Deps) {
  async function load(id: string, owner: ParticipantLookupInput) {
    let events: readonly StoredEvent[];
    try {
      events = await readCompleteStream(deps.eventStore, { streamId: `support.support-request-${id}` });
    } catch {
      throw new ParticipantAttemptError(503, "authority-unavailable");
    }
    const opened = events[0];
    if (
      opened &&
      opened.payload.buyerAccountId !== owner.accountId &&
      opened.payload.sellerAccountId !== owner.accountId
    )
      throw new ParticipantAttemptError(403, "support-request-unavailable");
    try {
      return { events, ...validateParticipantHistory(events, id) };
    } catch {
      throw new ParticipantAttemptError(503, "history-invalid");
    }
  }
  function authorize(loaded: Awaited<ReturnType<typeof load>>, input: ParticipantLookupInput) {
    if (!loaded.events.length) return;
    participant(loaded.state, input.accountId);
  }
  function recorded(loaded: Awaited<ReturnType<typeof load>>, input: ParticipantLookupInput, id: string) {
    const entry = loaded.receipts.find(({ receipt }) => sameOwner(receipt, input, id));
    if (!entry) return null;
    if (entry.receipt.actionKind !== input.actionKind || entry.receipt.requestHash !== input.attempt.requestHash)
      throw new ParticipantAttemptError(409, "participant-attempt-conflict");
    return entry.receipt.result;
  }
  async function confirmRecordedEvidence(
    loaded: Awaited<ReturnType<typeof load>>,
    input: ParticipantLookupInput,
    id: string,
    canonical: string,
    context: EventStoreContext,
  ) {
    if (input.actionKind !== "submit-evidence" && input.actionKind !== "open-support-request") return;
    const entry = loaded.receipts.find(({ receipt }) => sameOwner(receipt, input, id))!;
    const fact = entry.facts.find((event) => event.eventType === "support.support-request.evidence-submitted");
    if (!fact && input.actionKind === "open-support-request") return;
    if (!fact) throw new ParticipantAttemptError(503, "history-invalid");
    const event = createPassthroughDomainEventCodec<SupportRequestEvent>().decode(fact);
    if (event.type !== "support.support-request.evidence-submitted")
      throw new ParticipantAttemptError(503, "history-invalid");
    const b = payload(canonical);
    const fence = await deps.prepareEvidence(
      {
        ...event.data.evidence,
        type: "SubmitSupportEvidence",
        ...(b.attachmentOperationId ? { attachmentOperationId: b.attachmentOperationId } : {}),
      },
      loaded.state,
      loaded.version,
      context,
    );
    await fence.confirm();
  }
  return {
    execute: async (input: ParticipantCommandInput, context: EventStoreContext): Promise<ParticipantResult> => {
      if (
        context.audit.forAccountId !== input.accountId ||
        (input.actor && (input.actor.tenantId !== context.tenantId || input.actor.accountId !== input.accountId))
      )
        throw new ParticipantAttemptError(403, "participant-actor-mismatch");
      const attempt = parseParticipantAttempt(input.attempt);
      const lookupInput = { ...input, attempt, tenantId: context.tenantId };
      const id = target(lookupInput);
      const hasAttachments =
        input.actionKind === "submit-evidence" &&
        input.body !== null &&
        typeof input.body === "object" &&
        Array.isArray((input.body as Record<string, unknown>).attachments) &&
        ((input.body as Record<string, unknown>).attachments as unknown[]).length > 0;
      const loaded = await load(id, lookupInput).catch(async (error: unknown) => {
        if (hasAttachments && error instanceof ParticipantAttemptError && error.status === 403)
          await deps.authorizeEvidence?.(id, input.actor ?? null);
        throw error;
      });
      const ownsReceipt = loaded.receipts.some(({ receipt }) => sameOwner(receipt, lookupInput, id));
      if (hasAttachments && !ownsReceipt) await deps.authorizeEvidence?.(id, input.actor ?? null);
      authorize(loaded, lookupInput);
      const canonical = canonicalParticipantRequest(input.actionKind, input.body);
      if (digest(canonical) !== attempt.requestHash)
        throw new ParticipantAttemptError(400, "participant-hash-mismatch");
      const replay = recorded(loaded, lookupInput, id);
      if (replay) {
        await confirmRecordedEvidence(loaded, lookupInput, id, canonical, context);
        recordCommittedEvents(
          loaded.receipts.find(({ receipt }) => sameOwner(receipt, lookupInput, id))!.facts,
          "platform-operations",
        );
        return replay;
      }
      const b = payload(canonical);
      const now = deps.now?.() ?? new Date().toISOString();
      const accountId = input.accountId as AccountId;
      const role = input.actionKind === "open-support-request" ? null : participant(loaded.state, accountId);
      if (b.submittedByRole && b.submittedByRole !== role)
        throw new ParticipantAttemptError(403, "participant-role-mismatch");
      let command: SupportRequestCommand;
      switch (input.actionKind) {
        case "open-support-request":
          command = await deps.prepareOpen(b, accountId, id as SupportRequestId, context);
          break;
        case "submit-evidence":
          command = {
            type: "SubmitSupportEvidence",
            evidenceId: createId("sev"),
            submittedByAccountId: accountId,
            submittedByRole: role!,
            evidenceType: b.evidenceType,
            summary: b.summary,
            occurredAt: b.occurredAt,
            submittedAt: now,
            attachments: b.attachments,
            ...(b.attachmentOperationId ? { attachmentOperationId: b.attachmentOperationId } : {}),
          };
          break;
        case "record-response":
          command = {
            type: "RecordSupportResponse",
            responseId: createId("srp"),
            submittedByAccountId: accountId,
            submittedByRole: role!,
            responseType: b.responseType,
            summary: b.summary,
            submittedAt: now,
            offerId: ["accept-return", "offer-partial-refund", "offer-replacement"].includes(b.responseType)
              ? createId("sof")
              : null,
            offerResolutionType: b.offerResolutionType ?? expectedOfferResolution(b.responseType),
            refundAmount: b.refundAmount,
            affectedLineIds: b.affectedLineIds,
            refundCurrencyCode: b.refundCurrencyCode,
          };
          break;
        case "accept-offer":
          command = {
            type: "AcceptSupportOffer",
            offerId: b.offerId,
            acceptedByAccountId: accountId,
            acceptedByRole: role!,
            acceptedAt: now,
          };
          break;
        case "decline-offer":
          command = {
            type: "DeclineSupportOffer",
            offerId: b.offerId,
            declinedByAccountId: accountId,
            declinedByRole: role!,
            declinedAt: now,
            summary: b.summary,
          };
          break;
        case "escalate":
          command = {
            type: "EscalateSupportRequest",
            escalatedAt: now,
            reason: b.reason,
            escalatedByAccountId: accountId,
            escalatedByRole: role!,
          };
          break;
        case "cancel":
          if (loaded.state.openedByAccountId !== accountId)
            throw new ParticipantAttemptError(403, "participant-cancel-refused");
          command = { type: "CancelSupportRequest", cancelledAt: now, reason: b.reason };
          break;
        case "close":
          command = { type: "CloseSupportRequest", closedAt: now };
          break;
        case "return-condition-dispute":
          if (role !== "seller") throw new ParticipantAttemptError(403, "participant-dispute-refused");
          command = {
            type: "DisputeReturnCondition",
            disputedAt: now,
            reason: b.reason,
            disputedByAccountId: accountId,
          };
          break;
      }
      const openFacts = command.type === "OpenSupportRequest" ? await decideSupportRequest(loaded.state, command) : [];
      const openedState = openFacts.reduce(evolveSupportRequest, loaded.state);
      const intakeEvidence: SubmitSupportEvidenceCommand | undefined =
        command.type === "OpenSupportRequest" && b.intakePhotoReferences.length
          ? {
              type: "SubmitSupportEvidence",
              evidenceId: createId("sev"),
              submittedByAccountId: accountId,
              submittedByRole: command.openedByRole,
              evidenceType: "photo",
              summary: t("support.routes.marketplace.accountSupport.photos.summary"),
              occurredAt: null,
              submittedAt: command.openedAt,
              attachments: b.intakePhotoReferences,
              attachmentOperationId: b.attachmentOperationId,
            }
          : undefined;
      const evidenceFence = intakeEvidence
        ? await deps.prepareEvidence(intakeEvidence, openedState, loaded.version, context)
        : command.type === "SubmitSupportEvidence"
          ? await deps.prepareEvidence(command, loaded.state, loaded.version, context)
          : undefined;
      if (evidenceFence && !intakeEvidence) command = evidenceFence.command;
      const facts =
        command.type === "OpenSupportRequest"
          ? [
              ...openFacts,
              ...(evidenceFence
                ? await decideSupportRequest(openedState, evidenceFence.command, evidenceFence.authority)
                : []),
            ]
          : await decideSupportRequest(loaded.state, command, evidenceFence?.authority);
      if (!facts.length) throw new ParticipantAttemptError(409, "participant-command-not-recorded");
      const codec = createPassthroughDomainEventCodec<SupportRequestEvent>();
      const encoded = facts.map(codec.encode);
      const firstResult = result(input.actionKind, id, loaded.version + facts.length + 1, facts);
      const receipt: ParticipantReceipt = {
        tenantId: context.tenantId,
        accountId,
        targetId: id,
        ...attempt,
        actionKind: input.actionKind,
        firstVersion: loaded.version + 1,
        factsHash: factsHash(encoded),
        result: firstResult,
      };
      try {
        const stored = await (evidenceFence?.append ?? deps.eventStore.appendToStream)({
          streamId: `support.support-request-${id}`,
          expectedVersion: loaded.version,
          wakeSourceContextName: "platform-operations",
          context,
          events: [
            ...encoded.map((event) => ({
              ...event,
              metadata: { participantAttempt: { ...attempt, actionKind: input.actionKind, targetId: id } },
            })),
            { eventType: PARTICIPANT_RECEIPT_EVENT, payload: receipt },
          ],
        });
        recordCommittedEvents(
          stored.filter((event) => event.eventType !== PARTICIPANT_RECEIPT_EVENT),
          "platform-operations",
        );
        await evidenceFence?.confirm();
        return firstResult;
      } catch (error) {
        if ((error as { code?: string }).code !== "concurrency_conflict") throw error;
        const winner = await load(id, lookupInput);
        authorize(winner, lookupInput);
        const replay = recorded(winner, lookupInput, id);
        if (replay) {
          await confirmRecordedEvidence(winner, lookupInput, id, canonical, context);
          recordCommittedEvents(
            winner.receipts.find(({ receipt }) => sameOwner(receipt, lookupInput, id))!.facts,
            "platform-operations",
          );
          return replay;
        }
        throw new ParticipantAttemptError(409, "participant-concurrency-unknown");
      }
    },
    lookup: async (input: ParticipantLookupInput): Promise<ParticipantLookup> => {
      parseParticipantAttempt(input.attempt);
      const id = target(input);
      try {
        const loaded = await load(id, input);
        authorize(loaded, input);
        const replay = recorded(loaded, input, id);
        if (!replay) return { outcome: "not-recorded" };
        const entry = loaded.receipts.find(({ receipt }) => sameOwner(receipt, input, id))!;
        const reflected = await deps.isReflected(entry.facts);
        recordCommittedEvents(entry.facts, "platform-operations");
        return { outcome: reflected ? "committed" : "confirming", actionKind: input.actionKind, result: replay };
      } catch (error) {
        if (error instanceof ParticipantAttemptError && (error.status === 403 || error.status === 409))
          return { outcome: "not-recorded" };
        return {
          outcome: "unknown",
          reason:
            error instanceof ParticipantAttemptError && error.code === "history-invalid"
              ? "history-invalid"
              : "authority-unavailable",
        };
      }
    },
  };
}
