import type { EventStore } from "@chase-sets/event-core/event-store";
import type { AppendToStreamInput, EventStoreContext } from "@chase-sets/event-core/storage";
import type { CheckoutSessionId } from "@chase-sets/primitives/typed-ids";
import { CheckoutDomainError } from "../../../support/runtime-support/common";
import {
  checkoutCommandAttemptActorBinding,
  checkoutCommandAttemptCompletedEvent,
  checkoutCommandAttemptFingerprint,
  checkoutCommandAttemptStreamId,
  readCheckoutCommandAttemptHistory,
  type CheckoutCommandAttemptHistory,
} from "./attempt-history";
import {
  CHECKOUT_ENTRY_ATTEMPT_KIND,
  CHECKOUT_ENTRY_ATTEMPT_TARGET,
  type CheckoutCommandAttemptResult,
} from "./contracts";

/** One deliberate entry submission: its caller-created key and the hash of its canonical payload. */
export type CheckoutEntryAttempt = Readonly<{ attemptId: string; requestHash: string }>;

/**
 * The same entry key presented with a different canonical payload, or a key
 * whose recorded history cannot be trusted. Either way nothing appends and the
 * caller needs a fresh key for its next deliberate submission.
 */
export class CheckoutEntryAttemptConflict extends CheckoutDomainError {
  public constructor() {
    super("This checkout entry was already used for a different checkout.", "checkout_attempt_conflict");
    this.name = "CheckoutEntryAttemptConflict";
  }
}

export type CheckoutEntryAttemptReplay = Readonly<{
  sessionId: CheckoutSessionId;
  result: CheckoutCommandAttemptResult;
}>;

function entryFingerprint(ownerKey: string, attemptId: string) {
  return checkoutCommandAttemptFingerprint({
    ownerKey,
    kind: CHECKOUT_ENTRY_ATTEMPT_KIND,
    target: CHECKOUT_ENTRY_ATTEMPT_TARGET,
    attemptId,
  });
}

function baseResult(
  ownerKey: string,
  attempt: CheckoutEntryAttempt,
  fingerprint: string,
): Omit<CheckoutCommandAttemptResult, "ownerStatus"> {
  return {
    schemaVersion: 1,
    kind: CHECKOUT_ENTRY_ATTEMPT_KIND,
    fingerprint,
    actorBinding: checkoutCommandAttemptActorBinding(ownerKey),
    target: CHECKOUT_ENTRY_ATTEMPT_TARGET,
    requestHash: attempt.requestHash,
  };
}

/** A recorded entry is trusted only when it is a committed entry of this exact owner that names a Session. */
function trustedRecordedEntry(ownerKey: string, history: Exclude<CheckoutCommandAttemptHistory, { kind: "absent" }>) {
  if (history.kind !== "recorded") return null;
  const recorded = history.result;
  const binding = checkoutCommandAttemptActorBinding(ownerKey);
  return recorded.kind === CHECKOUT_ENTRY_ATTEMPT_KIND &&
    recorded.target === CHECKOUT_ENTRY_ATTEMPT_TARGET &&
    recorded.ownerStatus === "committed" &&
    recorded.actorBinding.kind === binding.kind &&
    recorded.actorBinding.digest === binding.digest &&
    typeof recorded.sessionId === "string"
    ? recorded
    : null;
}

/**
 * Reads the entry attempt stream once. Absent is `null`: the caller may open a
 * Session. The same key and hash replays the first Session; a changed hash, or
 * history that is not one trusted entry of this owner, is a conflict. Neither
 * outcome appends.
 */
export async function resolveCheckoutEntryAttempt(
  eventStore: Pick<EventStore, "readStream">,
  ownerKey: string,
  attempt: CheckoutEntryAttempt,
): Promise<CheckoutEntryAttemptReplay | null> {
  const history = await readCheckoutCommandAttemptHistory(eventStore, entryFingerprint(ownerKey, attempt.attemptId));
  if (history.kind === "absent") return null;
  const recorded = trustedRecordedEntry(ownerKey, history);
  if (!recorded || recorded.requestHash !== attempt.requestHash) {
    throw new CheckoutEntryAttemptConflict();
  }
  return { sessionId: recorded.sessionId as CheckoutSessionId, result: recorded };
}

/**
 * The attempt-stream append that rides in the same all-or-nothing
 * `appendToStreams` as the Session's started event, at `no_stream`, so a lost
 * race leaves neither the Session nor the attempt behind.
 */
export function checkoutEntryAttemptAppend(
  ownerKey: string,
  attempt: CheckoutEntryAttempt,
  sessionId: CheckoutSessionId,
  context: EventStoreContext,
): AppendToStreamInput {
  const fingerprint = entryFingerprint(ownerKey, attempt.attemptId);
  const result: CheckoutCommandAttemptResult = {
    ...baseResult(ownerKey, attempt, fingerprint),
    ownerStatus: "committed",
    sessionId,
  };
  return {
    streamId: checkoutCommandAttemptStreamId(fingerprint),
    expectedVersion: "no_stream",
    context,
    events: [checkoutCommandAttemptCompletedEvent(result)],
  };
}

/** The commit receipt a replayed entry proves: the attempt event appended with the Session's started event. */
export function checkoutEntryReplayCommitMetadata(result: CheckoutCommandAttemptResult) {
  const receipt = result.commitReceipt;
  return receipt
    ? {
        commitPosition: receipt.globalPosition,
        commitEventIds: [receipt.eventId],
        commitPositions: [
          { sourceContextName: "checkout", maxGlobalPosition: receipt.globalPosition, eventIds: [receipt.eventId] },
        ],
      }
    : {};
}

/**
 * The owner lookup for one entry attempt: one stream read, no write. Missing
 * and foreign attempts address a stream that does not exist under the
 * presenter's own binding, so both answer `not-observed`.
 */
export async function lookupCheckoutEntryAttempt(
  eventStore: Pick<EventStore, "readStream">,
  request: Readonly<{ ownerKey: string; attemptId: string; requestHash: string }>,
): Promise<CheckoutCommandAttemptResult> {
  const attempt = { attemptId: request.attemptId, requestHash: request.requestHash };
  const fingerprint = entryFingerprint(request.ownerKey, request.attemptId);
  const base = baseResult(request.ownerKey, attempt, fingerprint);
  const history = await readCheckoutCommandAttemptHistory(eventStore, fingerprint);
  if (history.kind === "absent") return { ...base, ownerStatus: "not-observed" };
  const recorded = trustedRecordedEntry(request.ownerKey, history);
  if (!recorded) return { ...base, ownerStatus: "ambiguous", reason: "history-incomplete" };
  return recorded.requestHash === request.requestHash ? recorded : { ...base, ownerStatus: "conflict" };
}
