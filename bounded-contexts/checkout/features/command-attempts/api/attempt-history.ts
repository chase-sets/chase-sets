import { createHash } from "node:crypto";
import { EventStreamTooLongError, readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventRecordToStore, StoredEvent } from "@chase-sets/event-core/storage";
import type { JsonObject } from "@chase-sets/primitives/json";
import {
  parseCheckoutCommandAttemptResult,
  type CheckoutCommandAttemptKind,
  type CheckoutCommandAttemptResult,
} from "./contracts";

/** The one event an attempt stream may hold (decision 3). */
export const CHECKOUT_COMMAND_ATTEMPT_COMPLETED = "checkout.command-attempt.completed";

export type CheckoutCommandAttemptBinding = Readonly<{
  ownerKey: string;
  kind: CheckoutCommandAttemptKind;
  target: string;
  attemptId: string;
}>;

function sha256Hex(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function checkoutCommandAttemptActorBinding(ownerKey: string): CheckoutCommandAttemptResult["actorBinding"] {
  return {
    kind: ownerKey.startsWith("anon_") ? "anonymous" : "account",
    digest: sha256Hex(`checkout-command-attempt-actor/v1\n${ownerKey}`),
  };
}

/**
 * SHA-256 over actor binding, kind, target and attempt id. The raw attempt id
 * and the raw owner key are never stored: the stream id and the event carry
 * only digests, so a lookup can address an attempt only by presenting the same
 * owner, kind, target and id it was created with.
 */
export function checkoutCommandAttemptFingerprint(binding: CheckoutCommandAttemptBinding) {
  return sha256Hex(
    ["checkout-command-attempt/v1", binding.ownerKey, binding.kind, binding.target, binding.attemptId].join("\n"),
  );
}

/**
 * Order-cart cleanup attempt ids are derived, never minted: base64url SHA-256
 * of session id, owner and line (or `checkout`), so a resumed cleanup addresses
 * the attempt its first run recorded and replays that result.
 */
export function checkoutOrderCartCleanupAttemptId(sessionId: string, ownerKey: string, target: string) {
  return createHash("sha256")
    .update(`checkout-order-cart-cleanup/v1\n${sessionId}\n${ownerKey}\n${target}`)
    .digest("base64url");
}

export function checkoutCommandAttemptStreamId(fingerprint: string) {
  return `checkout.command-attempt-v1-${fingerprint}`;
}

export type CheckoutCommandAttemptHistory =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "recorded"; result: CheckoutCommandAttemptResult }>
  | Readonly<{ kind: "history-incomplete" }>;

/**
 * Reads one attempt stream completely. More than one event, an unknown event
 * type, or a payload that fails the closed result schema is
 * `history-incomplete` -- never a replayable result and never "absent", so a
 * poisoned stream can neither replay a forged result nor be re-decided.
 */
export async function readCheckoutCommandAttemptHistory(
  eventStore: Pick<EventStore, "readStream">,
  fingerprint: string,
): Promise<CheckoutCommandAttemptHistory> {
  let events: readonly StoredEvent[];
  try {
    events = await readCompleteStream(eventStore, {
      streamId: checkoutCommandAttemptStreamId(fingerprint),
      maxEvents: 1,
    });
  } catch (error) {
    if (error instanceof EventStreamTooLongError) {
      return { kind: "history-incomplete" };
    }
    throw error;
  }
  if (events.length === 0) {
    return { kind: "absent" };
  }
  const [event] = events;
  if (event!.eventType !== CHECKOUT_COMMAND_ATTEMPT_COMPLETED) {
    return { kind: "history-incomplete" };
  }
  const payload = parseCheckoutCommandAttemptResult(event!.payload);
  if (!payload || payload.fingerprint !== fingerprint || payload.commitReceipt !== undefined) {
    return { kind: "history-incomplete" };
  }
  if (payload.ownerStatus !== "committed" && payload.ownerStatus !== "failed-safe") {
    return { kind: "history-incomplete" };
  }
  return {
    kind: "recorded",
    result: { ...payload, commitReceipt: { eventId: event!.eventId, globalPosition: String(event!.globalPosition) } },
  };
}

/** The attempt event appended beside the cart events; its own stored position is the commit receipt. */
export function checkoutCommandAttemptCompletedEvent(result: CheckoutCommandAttemptResult): EventRecordToStore {
  const { commitReceipt: _receipt, ...payload } = result;
  return { eventType: CHECKOUT_COMMAND_ATTEMPT_COMPLETED, payload: payload as unknown as JsonObject };
}

export function withCheckoutCommandAttemptReceipt(
  result: CheckoutCommandAttemptResult,
  storedAttemptEvent: StoredEvent | undefined,
): CheckoutCommandAttemptResult {
  return storedAttemptEvent
    ? {
        ...result,
        commitReceipt: {
          eventId: storedAttemptEvent.eventId,
          globalPosition: String(storedAttemptEvent.globalPosition),
        },
      }
    : result;
}
