import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core/domain";
import { EventStreamTooLongError, readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type {
  AppendToStreamInput,
  EventStoreContext,
  ExpectedStreamVersion,
  StoredEvent,
} from "@chase-sets/event-core/storage";
import { parseIsoUtcTimestamp } from "@chase-sets/primitives/iso-utc-timestamp";
import { isPolicyKey } from "./define-policy";
import { PlatformPolicyDomainError } from "./domain";

/**
 * The Consent Activation Authority: one event-sourced aggregate per
 * consent-capable policy key that owns whether that key is activated, which
 * version is active, and the expected-version token a caller guards an
 * `appendToStreams` transaction with.
 *
 * Two properties are the whole point of this module and every change here
 * must preserve both.
 *
 * 1. THE IDENTITY IS DERIVED FROM THE POLICY KEY ALONE. A policy document id
 *    does not exist until a document is created, so a document-keyed stream
 *    cannot guard the *first* activation of a key -- the state that has no
 *    stream to point at is exactly the state a registration must be able to
 *    reject against. `consentActivationAuthorityStreamId` therefore takes the
 *    policy key and nothing else, and is valid from the never-activated state
 *    onward.
 *
 * 2. ACTIVATION STATE AND THE GUARD TOKEN COME FROM ONE READ OF ONE SOURCE.
 *    `readConsentActivationAuthority` folds the authority stream's events into
 *    state and derives the expected-version token from that same event list,
 *    in the same call. It never consults `PolicyCache`, never reads
 *    `platform_policy_documents`, and never pairs a value taken from a
 *    projection with a revision taken from a stream. A resolution that pairs a
 *    cached policy value with an independently read stream revision records
 *    the stale value against the newer revision, which is the defect this
 *    module exists to make unrepresentable.
 *
 * Activation is decided by AGGREGATE STATE, never by the presence of a stream,
 * a stream row, a projection row, or a policy document. A policy key with an
 * active `platform_policy_documents` row and no activation on its authority
 * reads as inactive, and that is correct: the document is the value, the
 * authority is the activation.
 */

/**
 * Fixed, mechanism-level prefix -- deliberately not a mounting context's own
 * stream prefix, matching `POLICY_DOCUMENT_STREAM_PREFIX` in `runtime.ts`,
 * because one shared aggregate type is reused by every context that adopts
 * `definePolicy`. Policy keys are themselves dotted, so an authority stream id
 * carries two dot-separated segments after the prefix; `streamContextName`
 * splits on the first dot and still resolves `platform-policy`.
 */
export const CONSENT_ACTIVATION_AUTHORITY_STREAM_PREFIX = "platform-policy.consent-activation-authority-";

/** Upper bound on authority events replayed for one key before the read fails closed. */
const MAX_AUTHORITY_HISTORY_EVENTS = 10_000;

const MAX_POLICY_KEY_LENGTH = 128;
const MAX_VERSION_TOKEN_LENGTH = 64;
const MAX_DOCUMENT_ID_LENGTH = 64;
const MAX_ACTOR_USER_ID_LENGTH = 128;
const MAX_CONTEXT_NAME_LENGTH = 64;
const MAX_SCHEMA_SUMMARY_LENGTH = 256;

const VERSION_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DOCUMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CONTEXT_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

/** Explicit instant bounds. A record outside this window is malformed, not merely old. */
const MIN_INSTANT_MS = Date.parse("2020-01-01T00:00:00.000Z");
const MAX_INSTANT_MS = Date.parse("2200-01-01T00:00:00.000Z");

export type ConsentActivationAuthorityErrorCode =
  /** The policy key is not a well-formed dotted policy key, or exceeds its length bound. */
  | "invalid_policy_key"
  /** An event on the authority stream is not a Consent Activation Authority event type. */
  | "unknown_event_type"
  /** An activation envelope failed closed-shape, instant, or bounds validation. */
  | "invalid_activation_envelope"
  /** An event's `policyKey` does not match the key its stream is derived from. */
  | "policy_key_mismatch"
  /** An event is impossible from the state its predecessors produced. */
  | "invalid_transition"
  /** A repeated registration carries metadata that contradicts the recorded registration. */
  | "registration_conflict"
  /** A command requires the key to be registered as consent-capable first. */
  | "not_registered"
  /** The snapshot is not a recursively closed object with bounded primitive fields. */
  | "invalid_snapshot_shape"
  /** The snapshot policy key differs from the key requested at the runtime boundary. */
  | "snapshot_policy_key_mismatch"
  /** The snapshot or guard stream id is not the canonical identity for its policy key. */
  | "snapshot_stream_id_mismatch"
  /** The snapshot fields describe an impossible Consent Activation Authority lifecycle state. */
  | "snapshot_lifecycle_mismatch"
  /** The snapshot authority revision is outside its bounds or inconsistent with its lifecycle. */
  | "snapshot_revision_mismatch"
  /** The nested guard is not bound exactly to the snapshot identity and authority revision. */
  | "snapshot_guard_mismatch"
  /** The guard append helper received a value not minted by the canonical snapshot decoder. */
  | "unvalidated_activation_guard"
  /** The authority history exceeded its replay bound. */
  | "history_too_long";

/**
 * Named, coded failure. Rehydration never falls back to an invented state: a
 * malformed or impossible authority history raises this instead of resolving,
 * so a caller cannot proceed against a record the authority could not read.
 */
export class ConsentActivationAuthorityError extends PlatformPolicyDomainError {
  public readonly code: ConsentActivationAuthorityErrorCode;

  public constructor(code: ConsentActivationAuthorityErrorCode, message: string) {
    super(message);
    this.name = "ConsentActivationAuthorityError";
    this.code = code;
  }
}

function fail(code: ConsentActivationAuthorityErrorCode, message: string): never {
  throw new ConsentActivationAuthorityError(code, message);
}

export function assertConsentCapablePolicyKey(policyKey: unknown): asserts policyKey is string {
  if (typeof policyKey !== "string" || policyKey.length > MAX_POLICY_KEY_LENGTH || !isPolicyKey(policyKey)) {
    fail(
      "invalid_policy_key",
      `Consent activation authority policy key must be a dotted lowercase key of at most ${MAX_POLICY_KEY_LENGTH} characters.`,
    );
  }
}

/**
 * The deterministic authority identity. Derived from the policy key alone, so
 * it is stable and guardable before any document, any activation, and any
 * event exists for that key.
 */
export function consentActivationAuthorityStreamId(policyKey: string): string {
  assertConsentCapablePolicyKey(policyKey);
  return `${CONSENT_ACTIVATION_AUTHORITY_STREAM_PREFIX}${policyKey}`;
}

export type ConsentActivationStatus = "never-activated" | "active" | "inactive";

export type ConsentActivationAuthorityState = Readonly<{
  policyKey: string | null;
  contextName: string | null;
  schemaSummary: string | null;
  /** Consent-CAPABLE. Registration declares capability; it never implies activation. */
  registered: boolean;
  /**
   * `never-activated` and `inactive` are distinct states, not two spellings of
   * absence: a key that was activated and then deactivated must not read as a
   * key that was never activated, because only the latter can legitimately be
   * first-activated.
   */
  status: ConsentActivationStatus;
  activeVersion: string | null;
  activeDocumentId: string | null;
  activationCount: number;
  lastTransitionAt: string | null;
}>;

export const initialConsentActivationAuthorityState: ConsentActivationAuthorityState = {
  policyKey: null,
  contextName: null,
  schemaSummary: null,
  registered: false,
  status: "never-activated",
  activeVersion: null,
  activeDocumentId: null,
  activationCount: 0,
  lastTransitionAt: null,
};

export type ConsentCapableRegistration = Readonly<{
  contextName: string;
  schemaSummary: string;
  registeredAt: string;
}>;

export type ConsentActivationEnvelope = Readonly<{
  version: string;
  documentId: string;
  activatedAt: string;
  actorUserId: string;
}>;

export type ConsentDeactivationEnvelope = Readonly<{
  deactivatedVersion: string;
  deactivatedAt: string;
  actorUserId: string;
}>;

export type ConsentCapablePolicyRegisteredEvent = DomainEvent<
  "platform-policy.consent-activation-authority.registered",
  Readonly<{ policyKey: string; registration: ConsentCapableRegistration }>
>;

export type ConsentPolicyActivatedEvent = DomainEvent<
  "platform-policy.consent-activation-authority.activated",
  Readonly<{ policyKey: string; activation: ConsentActivationEnvelope }>
>;

export type ConsentPolicyActivationReplacedEvent = DomainEvent<
  "platform-policy.consent-activation-authority.replaced",
  Readonly<{ policyKey: string; previousVersion: string; activation: ConsentActivationEnvelope }>
>;

export type ConsentPolicyDeactivatedEvent = DomainEvent<
  "platform-policy.consent-activation-authority.deactivated",
  Readonly<{ policyKey: string; deactivation: ConsentDeactivationEnvelope }>
>;

export type ConsentActivationAuthorityEvent =
  | ConsentCapablePolicyRegisteredEvent
  | ConsentPolicyActivatedEvent
  | ConsentPolicyActivationReplacedEvent
  | ConsentPolicyDeactivatedEvent;

export const CONSENT_ACTIVATION_AUTHORITY_EVENT_TYPES = [
  "platform-policy.consent-activation-authority.registered",
  "platform-policy.consent-activation-authority.activated",
  "platform-policy.consent-activation-authority.replaced",
  "platform-policy.consent-activation-authority.deactivated",
] as const;

export type RegisterConsentCapablePolicyCommand = Readonly<{
  type: "RegisterConsentCapablePolicy";
  policyKey: string;
  contextName: string;
  schemaSummary: string;
  registeredAt: string;
}>;

export type ActivateConsentPolicyVersionCommand = Readonly<{
  type: "ActivateConsentPolicyVersion";
  policyKey: string;
  version: string;
  documentId: string;
  activatedAt: string;
  actorUserId: string;
}>;

export type DeactivateConsentPolicyCommand = Readonly<{
  type: "DeactivateConsentPolicy";
  policyKey: string;
  deactivatedAt: string;
  actorUserId: string;
}>;

export type ConsentActivationAuthorityCommand =
  | RegisterConsentCapablePolicyCommand
  | ActivateConsentPolicyVersionCommand
  | DeactivateConsentPolicyCommand;

/* -------------------------------------------------------------------------- */
/* Envelope validation                                                         */
/* -------------------------------------------------------------------------- */

function closedObject(
  value: unknown,
  allowedKeys: readonly string[],
  path: string,
  errorCode: ConsentActivationAuthorityErrorCode = "invalid_activation_envelope",
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(errorCode, `Consent activation authority record '${path}' must be an object.`);
  }

  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail(errorCode, `Consent activation authority record '${path}' must be a plain object.`);
    }

    const record = value as Record<string, unknown>;
    const closedRecord: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(record)) {
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (
        typeof key !== "string" ||
        !allowedKeys.includes(key) ||
        descriptor === undefined ||
        !("value" in descriptor)
      ) {
        fail(errorCode, `Consent activation authority record '${path}' has unexpected field '${String(key)}'.`);
      }
      closedRecord[key] = descriptor.value;
    }
    return closedRecord;
  } catch (error) {
    if (error instanceof ConsentActivationAuthorityError) {
      throw error;
    }
    fail(errorCode, `Consent activation authority record '${path}' must be a readable, closed plain object.`);
  }
}

function boundedString(
  value: unknown,
  path: string,
  maxLength: number,
  pattern?: RegExp,
  errorCode: ConsentActivationAuthorityErrorCode = "invalid_activation_envelope",
): string {
  if (typeof value !== "string") {
    fail(errorCode, `Consent activation authority field '${path}' must be a string.`);
  }
  if (value.length === 0 || value.length > maxLength) {
    fail(errorCode, `Consent activation authority field '${path}' must be 1-${maxLength} characters.`);
  }
  if (pattern && !pattern.test(value)) {
    fail(errorCode, `Consent activation authority field '${path}' has an unsupported shape.`);
  }
  return value;
}

/**
 * Timezone-bearing instant, within explicit bounds. A date-only value, a local
 * timestamp with no zone designator, and an instant outside the supported
 * window are each rejected rather than coerced.
 */
function boundedInstant(
  value: unknown,
  path: string,
  errorCode: ConsentActivationAuthorityErrorCode = "invalid_activation_envelope",
): string {
  if (typeof value !== "string") {
    fail(errorCode, `Consent activation authority instant '${path}' must be a string.`);
  }

  let parsed: string;
  try {
    parsed = parseIsoUtcTimestamp(value);
  } catch {
    fail(errorCode, `Consent activation authority instant '${path}' must be a timezone-bearing ISO-8601 UTC instant.`);
  }

  const milliseconds = Date.parse(parsed);
  if (milliseconds < MIN_INSTANT_MS || milliseconds >= MAX_INSTANT_MS) {
    fail(errorCode, `Consent activation authority instant '${path}' is outside supported bounds.`);
  }

  return parsed;
}

function decodeRegistration(value: unknown): ConsentCapableRegistration {
  const record = closedObject(value, ["contextName", "schemaSummary", "registeredAt"], "registration");
  return {
    contextName: boundedString(
      record.contextName,
      "registration.contextName",
      MAX_CONTEXT_NAME_LENGTH,
      CONTEXT_NAME_PATTERN,
    ),
    schemaSummary: boundedString(record.schemaSummary, "registration.schemaSummary", MAX_SCHEMA_SUMMARY_LENGTH),
    registeredAt: boundedInstant(record.registeredAt, "registration.registeredAt"),
  };
}

function decodeActivation(value: unknown): ConsentActivationEnvelope {
  const record = closedObject(value, ["version", "documentId", "activatedAt", "actorUserId"], "activation");
  return {
    version: boundedString(record.version, "activation.version", MAX_VERSION_TOKEN_LENGTH, VERSION_TOKEN_PATTERN),
    documentId: boundedString(record.documentId, "activation.documentId", MAX_DOCUMENT_ID_LENGTH, DOCUMENT_ID_PATTERN),
    activatedAt: boundedInstant(record.activatedAt, "activation.activatedAt"),
    actorUserId: boundedString(record.actorUserId, "activation.actorUserId", MAX_ACTOR_USER_ID_LENGTH),
  };
}

function decodeDeactivation(value: unknown): ConsentDeactivationEnvelope {
  const record = closedObject(value, ["deactivatedVersion", "deactivatedAt", "actorUserId"], "deactivation");
  return {
    deactivatedVersion: boundedString(
      record.deactivatedVersion,
      "deactivation.deactivatedVersion",
      MAX_VERSION_TOKEN_LENGTH,
      VERSION_TOKEN_PATTERN,
    ),
    deactivatedAt: boundedInstant(record.deactivatedAt, "deactivation.deactivatedAt"),
    actorUserId: boundedString(record.actorUserId, "deactivation.actorUserId", MAX_ACTOR_USER_ID_LENGTH),
  };
}

/**
 * Validates one stored authority record into its typed event. Key presence is
 * not value validity: every payload is closed recursively, every instant must
 * carry a zone designator and fall inside explicit bounds, and every token is
 * length- and shape-bounded before any of it reaches the fold.
 */
export function decodeConsentActivationAuthorityEvent(stored: {
  eventType: string;
  payload: unknown;
}): ConsentActivationAuthorityEvent {
  switch (stored.eventType) {
    case "platform-policy.consent-activation-authority.registered": {
      const payload = closedObject(stored.payload, ["policyKey", "registration"], "registered");
      return {
        type: stored.eventType,
        data: {
          policyKey: boundedString(payload.policyKey, "registered.policyKey", MAX_POLICY_KEY_LENGTH),
          registration: decodeRegistration(payload.registration),
        },
      };
    }
    case "platform-policy.consent-activation-authority.activated": {
      const payload = closedObject(stored.payload, ["policyKey", "activation"], "activated");
      return {
        type: stored.eventType,
        data: {
          policyKey: boundedString(payload.policyKey, "activated.policyKey", MAX_POLICY_KEY_LENGTH),
          activation: decodeActivation(payload.activation),
        },
      };
    }
    case "platform-policy.consent-activation-authority.replaced": {
      const payload = closedObject(stored.payload, ["policyKey", "previousVersion", "activation"], "replaced");
      return {
        type: stored.eventType,
        data: {
          policyKey: boundedString(payload.policyKey, "replaced.policyKey", MAX_POLICY_KEY_LENGTH),
          previousVersion: boundedString(
            payload.previousVersion,
            "replaced.previousVersion",
            MAX_VERSION_TOKEN_LENGTH,
            VERSION_TOKEN_PATTERN,
          ),
          activation: decodeActivation(payload.activation),
        },
      };
    }
    case "platform-policy.consent-activation-authority.deactivated": {
      const payload = closedObject(stored.payload, ["policyKey", "deactivation"], "deactivated");
      return {
        type: stored.eventType,
        data: {
          policyKey: boundedString(payload.policyKey, "deactivated.policyKey", MAX_POLICY_KEY_LENGTH),
          deactivation: decodeDeactivation(payload.deactivation),
        },
      };
    }
    default:
      return fail(
        "unknown_event_type",
        `Event type '${stored.eventType}' is not a consent activation authority event.`,
      );
  }
}

/* -------------------------------------------------------------------------- */
/* Fold                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Strict fold. Every event must be possible from the state its predecessors
 * produced; an impossible one raises rather than being absorbed. Convergence is
 * never inferred from an event type being present or absent -- a repeated
 * registration converges only when its metadata matches what was recorded, and
 * contradicts (fails closed) when it does not.
 */
export const evolveConsentActivationAuthority: AggregateEvolver<
  ConsentActivationAuthorityState,
  ConsentActivationAuthorityEvent
> = (state, event) => {
  if (state.policyKey !== null && state.policyKey !== event.data.policyKey) {
    fail(
      "policy_key_mismatch",
      `Consent activation authority for '${state.policyKey}' carries an event for '${event.data.policyKey}'.`,
    );
  }

  switch (event.type) {
    case "platform-policy.consent-activation-authority.registered": {
      const { registration } = event.data;
      if (state.registered) {
        if (state.contextName !== registration.contextName || state.schemaSummary !== registration.schemaSummary) {
          fail(
            "registration_conflict",
            `Consent activation authority for '${event.data.policyKey}' is already registered with different metadata.`,
          );
        }
        return state;
      }

      return {
        ...state,
        policyKey: event.data.policyKey,
        contextName: registration.contextName,
        schemaSummary: registration.schemaSummary,
        registered: true,
        lastTransitionAt: registration.registeredAt,
      };
    }
    case "platform-policy.consent-activation-authority.activated": {
      if (!state.registered) {
        fail(
          "not_registered",
          `Consent activation authority for '${event.data.policyKey}' was activated before it was registered as consent-capable.`,
        );
      }
      if (state.status === "active") {
        fail(
          "invalid_transition",
          `Consent activation authority for '${event.data.policyKey}' is already active; a change of active version is a replacement.`,
        );
      }

      return {
        ...state,
        status: "active",
        activeVersion: event.data.activation.version,
        activeDocumentId: event.data.activation.documentId,
        activationCount: state.activationCount + 1,
        lastTransitionAt: event.data.activation.activatedAt,
      };
    }
    case "platform-policy.consent-activation-authority.replaced": {
      if (state.status !== "active") {
        fail(
          "invalid_transition",
          `Consent activation authority for '${event.data.policyKey}' cannot replace an activation while it is ${state.status}.`,
        );
      }
      if (state.activeVersion !== event.data.previousVersion) {
        fail(
          "invalid_transition",
          `Consent activation authority for '${event.data.policyKey}' replaced version '${event.data.previousVersion}' while '${state.activeVersion}' was active.`,
        );
      }

      return {
        ...state,
        activeVersion: event.data.activation.version,
        activeDocumentId: event.data.activation.documentId,
        activationCount: state.activationCount + 1,
        lastTransitionAt: event.data.activation.activatedAt,
      };
    }
    case "platform-policy.consent-activation-authority.deactivated": {
      if (state.status !== "active") {
        fail(
          "invalid_transition",
          `Consent activation authority for '${event.data.policyKey}' cannot be deactivated while it is ${state.status}.`,
        );
      }
      if (state.activeVersion !== event.data.deactivation.deactivatedVersion) {
        fail(
          "invalid_transition",
          `Consent activation authority for '${event.data.policyKey}' deactivated version '${event.data.deactivation.deactivatedVersion}' while '${state.activeVersion}' was active.`,
        );
      }

      return {
        ...state,
        status: "inactive",
        activeVersion: null,
        activeDocumentId: null,
        lastTransitionAt: event.data.deactivation.deactivatedAt,
      };
    }
    default:
      return fail("unknown_event_type", `Unhandled consent activation authority event: ${JSON.stringify(event)}`);
  }
};

export const decideConsentActivationAuthority: AggregateDecider<
  ConsentActivationAuthorityState,
  ConsentActivationAuthorityCommand,
  ConsentActivationAuthorityEvent
> = (state, command) => {
  assertConsentCapablePolicyKey(command.policyKey);

  // The rehydrated aggregate must belong to the key being commanded. Without
  // this, a stream carrying a foreign key's history would let a command read
  // as already-registered and converge against the wrong aggregate.
  if (state.policyKey !== null && state.policyKey !== command.policyKey) {
    fail(
      "policy_key_mismatch",
      `Consent activation authority for '${state.policyKey}' cannot serve a command for '${command.policyKey}'.`,
    );
  }

  switch (command.type) {
    case "RegisterConsentCapablePolicy": {
      const registration = decodeRegistration({
        contextName: command.contextName,
        schemaSummary: command.schemaSummary,
        registeredAt: command.registeredAt,
      });

      // Skip-if-exists reconciles rather than detects: an already-registered
      // key converges only when the recorded metadata matches. Contradicting
      // metadata raises instead of being passed over.
      if (state.registered) {
        if (state.contextName !== registration.contextName || state.schemaSummary !== registration.schemaSummary) {
          fail(
            "registration_conflict",
            `Consent activation authority for '${command.policyKey}' is already registered with different metadata.`,
          );
        }
        return [];
      }

      return [
        {
          type: "platform-policy.consent-activation-authority.registered",
          data: { policyKey: command.policyKey, registration },
        },
      ];
    }
    case "ActivateConsentPolicyVersion": {
      if (!state.registered) {
        fail(
          "not_registered",
          `Consent activation authority for '${command.policyKey}' must be registered as consent-capable before activation.`,
        );
      }

      const activation = decodeActivation({
        version: command.version,
        documentId: command.documentId,
        activatedAt: command.activatedAt,
        actorUserId: command.actorUserId,
      });

      if (state.status === "active") {
        if (state.activeVersion === activation.version && state.activeDocumentId === activation.documentId) {
          return [];
        }

        return [
          {
            type: "platform-policy.consent-activation-authority.replaced",
            data: {
              policyKey: command.policyKey,
              previousVersion: state.activeVersion as string,
              activation,
            },
          },
        ];
      }

      return [
        {
          type: "platform-policy.consent-activation-authority.activated",
          data: { policyKey: command.policyKey, activation },
        },
      ];
    }
    case "DeactivateConsentPolicy": {
      if (state.status !== "active") {
        fail(
          "invalid_transition",
          `Consent activation authority for '${command.policyKey}' cannot be deactivated while it is ${state.status}.`,
        );
      }

      return [
        {
          type: "platform-policy.consent-activation-authority.deactivated",
          data: {
            policyKey: command.policyKey,
            deactivation: decodeDeactivation({
              deactivatedVersion: state.activeVersion,
              deactivatedAt: command.deactivatedAt,
              actorUserId: command.actorUserId,
            }),
          },
        },
      ];
    }
    default:
      return fail("unknown_event_type", `Unhandled consent activation authority command: ${JSON.stringify(command)}`);
  }
};

/* -------------------------------------------------------------------------- */
/* Guard                                                                       */
/* -------------------------------------------------------------------------- */

const validatedConsentActivationGuards = new WeakSet<object>();

declare class ValidatedConsentActivationGuardContract {
  private readonly validatedConsentActivationGuardBrand: void;
  public readonly policyKey: string;
  public readonly streamId: string;
  public readonly expectedVersion: ExpectedStreamVersion;
}

declare class ValidatedConsentActivationAuthoritySnapshotContract {
  private readonly validatedConsentActivationAuthoritySnapshotBrand: void;
  public readonly policyKey: string;
  public readonly streamId: string;
  public readonly registered: boolean;
  public readonly status: ConsentActivationStatus;
  public readonly isActive: boolean;
  public readonly activeVersion: string | null;
  public readonly activeDocumentId: string | null;
  public readonly activationCount: number;
  public readonly lastTransitionAt: string | null;
  public readonly authorityVersion: number;
  public readonly guard: ValidatedConsentActivationGuard;
}

/**
 * The token a caller carries into an `appendToStreams` transaction. Minted by
 * `decodeConsentActivationAuthoritySnapshot` from the same validated record
 * as the state beside it. The private brand prevents repository callers from
 * structurally constructing a token for another stream or revision.
 */
export type ValidatedConsentActivationGuard = ValidatedConsentActivationGuardContract;

/**
 * The consumer-facing authority contract. It is opaque as well as readonly:
 * only `decodeConsentActivationAuthoritySnapshot` can mint the private brand,
 * and it freezes both objects so a validated value cannot be mutated into an
 * impossible lifecycle state after crossing the runtime boundary.
 */
export type ValidatedConsentActivationAuthoritySnapshot = ValidatedConsentActivationAuthoritySnapshotContract;

function snapshotBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    fail("invalid_snapshot_shape", `Consent activation authority snapshot field '${path}' must be a boolean.`);
  }
  return value;
}

function snapshotInteger(value: unknown, path: string, errorCode: ConsentActivationAuthorityErrorCode): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) >= MAX_AUTHORITY_HISTORY_EVENTS) {
    fail(
      errorCode,
      `Consent activation authority snapshot field '${path}' must be an integer from 0 through ${MAX_AUTHORITY_HISTORY_EVENTS - 1}.`,
    );
  }
  return value as number;
}

function snapshotNullableToken(value: unknown, path: string, maxLength: number, pattern: RegExp): string | null {
  return value === null ? null : boundedString(value, path, maxLength, pattern, "invalid_snapshot_shape");
}

function snapshotNullableInstant(value: unknown, path: string): string | null {
  return value === null ? null : boundedInstant(value, path, "invalid_snapshot_shape");
}

function assertSnapshotLifecycle(
  snapshot: Readonly<{
    registered: boolean;
    status: ConsentActivationStatus;
    isActive: boolean;
    activeVersion: string | null;
    activeDocumentId: string | null;
    activationCount: number;
    lastTransitionAt: string | null;
    authorityVersion: number;
    guardExpectedVersion: ExpectedStreamVersion;
  }>,
): void {
  const hasActiveFields = snapshot.activeVersion !== null && snapshot.activeDocumentId !== null;
  const hasNoActiveFields = snapshot.activeVersion === null && snapshot.activeDocumentId === null;

  if (!snapshot.registered) {
    if (
      snapshot.status !== "never-activated" ||
      snapshot.isActive ||
      !hasNoActiveFields ||
      snapshot.activationCount !== 0 ||
      snapshot.lastTransitionAt !== null ||
      snapshot.authorityVersion !== 0
    ) {
      fail(
        "snapshot_lifecycle_mismatch",
        "An unregistered consent activation authority must be the zero-event, never-activated state.",
      );
    }
    if (snapshot.guardExpectedVersion !== "no_stream") {
      fail(
        "snapshot_guard_mismatch",
        "A zero-event consent activation authority must carry the no_stream guard revision.",
      );
    }
    return;
  }

  if (snapshot.status === "never-activated") {
    if (
      snapshot.isActive ||
      !hasNoActiveFields ||
      snapshot.activationCount !== 0 ||
      snapshot.lastTransitionAt === null ||
      snapshot.authorityVersion !== 1
    ) {
      fail(
        "snapshot_lifecycle_mismatch",
        "A registered, never-activated consent activation authority must contain exactly its registration event.",
      );
    }
  } else if (snapshot.status === "active") {
    const minimumVersion = snapshot.activationCount + 1;
    const maximumVersion = 2 * snapshot.activationCount;
    if (
      !snapshot.isActive ||
      !hasActiveFields ||
      snapshot.activationCount < 1 ||
      snapshot.lastTransitionAt === null ||
      snapshot.authorityVersion < minimumVersion ||
      snapshot.authorityVersion > maximumVersion
    ) {
      fail(
        "snapshot_lifecycle_mismatch",
        "An active consent activation authority violates its activation lifecycle arithmetic.",
      );
    }
  } else {
    const minimumVersion = snapshot.activationCount + 2;
    const maximumVersion = 2 * snapshot.activationCount + 1;
    if (
      snapshot.isActive ||
      !hasNoActiveFields ||
      snapshot.activationCount < 1 ||
      snapshot.lastTransitionAt === null ||
      snapshot.authorityVersion < minimumVersion ||
      snapshot.authorityVersion > maximumVersion
    ) {
      fail(
        "snapshot_lifecycle_mismatch",
        "An inactive consent activation authority violates its activation lifecycle arithmetic.",
      );
    }
  }

  if (snapshot.guardExpectedVersion !== snapshot.authorityVersion) {
    fail(
      "snapshot_guard_mismatch",
      "A registered consent activation authority guard revision must equal its authority revision.",
    );
  }
}

/**
 * The single runtime trust boundary from unknown input to consumer-facing
 * Consent Activation Authority state. Every object is recursively closed,
 * identity is rebound to the requested policy key, lifecycle arithmetic is
 * exact, revisions are bounded, and malformed input raises without producing a
 * branded snapshot or guard.
 */
export function decodeConsentActivationAuthoritySnapshot(
  requestedPolicyKey: string,
  value: unknown,
): ValidatedConsentActivationAuthoritySnapshot {
  assertConsentCapablePolicyKey(requestedPolicyKey);
  const canonicalStreamId = consentActivationAuthorityStreamId(requestedPolicyKey);
  const snapshot = closedObject(
    value,
    [
      "policyKey",
      "streamId",
      "registered",
      "status",
      "isActive",
      "activeVersion",
      "activeDocumentId",
      "activationCount",
      "lastTransitionAt",
      "authorityVersion",
      "guard",
    ],
    "snapshot",
    "invalid_snapshot_shape",
  );

  const policyKey = boundedString(
    snapshot.policyKey,
    "snapshot.policyKey",
    MAX_POLICY_KEY_LENGTH,
    undefined,
    "invalid_snapshot_shape",
  );
  try {
    assertConsentCapablePolicyKey(policyKey);
  } catch {
    fail("invalid_snapshot_shape", "Consent activation authority snapshot policy key is not canonical.");
  }
  if (policyKey !== requestedPolicyKey) {
    fail(
      "snapshot_policy_key_mismatch",
      `Consent activation authority snapshot for '${policyKey}' cannot satisfy a read for '${requestedPolicyKey}'.`,
    );
  }

  if (typeof snapshot.streamId !== "string" || snapshot.streamId !== canonicalStreamId) {
    fail("snapshot_stream_id_mismatch", `Consent activation authority snapshot stream must be '${canonicalStreamId}'.`);
  }

  const status = snapshot.status;
  if (status !== "never-activated" && status !== "active" && status !== "inactive") {
    fail("invalid_snapshot_shape", "Consent activation authority snapshot status is unsupported.");
  }
  const decodedStatus = status as ConsentActivationStatus;

  const guardRecord = closedObject(
    snapshot.guard,
    ["policyKey", "streamId", "expectedVersion"],
    "snapshot.guard",
    "invalid_snapshot_shape",
  );
  if (guardRecord.policyKey !== policyKey) {
    fail("snapshot_guard_mismatch", "Consent activation authority guard policy key must equal the snapshot key.");
  }
  if (guardRecord.streamId !== canonicalStreamId) {
    fail("snapshot_stream_id_mismatch", `Consent activation authority guard stream must be '${canonicalStreamId}'.`);
  }
  const guardExpectedVersion =
    guardRecord.expectedVersion === "no_stream"
      ? "no_stream"
      : snapshotInteger(guardRecord.expectedVersion, "snapshot.guard.expectedVersion", "snapshot_guard_mismatch");

  const decoded = {
    policyKey,
    streamId: canonicalStreamId,
    registered: snapshotBoolean(snapshot.registered, "snapshot.registered"),
    status: decodedStatus,
    isActive: snapshotBoolean(snapshot.isActive, "snapshot.isActive"),
    activeVersion: snapshotNullableToken(
      snapshot.activeVersion,
      "snapshot.activeVersion",
      MAX_VERSION_TOKEN_LENGTH,
      VERSION_TOKEN_PATTERN,
    ),
    activeDocumentId: snapshotNullableToken(
      snapshot.activeDocumentId,
      "snapshot.activeDocumentId",
      MAX_DOCUMENT_ID_LENGTH,
      DOCUMENT_ID_PATTERN,
    ),
    activationCount: snapshotInteger(snapshot.activationCount, "snapshot.activationCount", "invalid_snapshot_shape"),
    lastTransitionAt: snapshotNullableInstant(snapshot.lastTransitionAt, "snapshot.lastTransitionAt"),
    authorityVersion: snapshotInteger(
      snapshot.authorityVersion,
      "snapshot.authorityVersion",
      "snapshot_revision_mismatch",
    ),
  };

  assertSnapshotLifecycle({ ...decoded, guardExpectedVersion });

  const guard = Object.freeze({
    policyKey,
    streamId: canonicalStreamId,
    expectedVersion: guardExpectedVersion,
  }) as unknown as ValidatedConsentActivationGuard;
  validatedConsentActivationGuards.add(guard);

  return Object.freeze({
    ...decoded,
    guard,
  }) as unknown as ValidatedConsentActivationAuthoritySnapshot;
}

/**
 * Renders a validated guard as an `appendToStreams` participant. The input
 * carries zero events: it contributes no history to the authority stream and
 * exists only so the shared all-or-nothing transaction rejects when the
 * authority moved between the read and the append.
 */
export function consentActivationGuardAppendInput(
  guard: ValidatedConsentActivationGuard,
  context: EventStoreContext,
): AppendToStreamInput {
  if (!validatedConsentActivationGuards.has(guard)) {
    fail(
      "unvalidated_activation_guard",
      "Consent activation authority append guards must come from the canonical snapshot decoder.",
    );
  }
  return {
    streamId: guard.streamId,
    expectedVersion: guard.expectedVersion,
    events: [],
    context,
  };
}

async function readAuthorityEvents(eventStore: EventStore, streamId: string): Promise<readonly StoredEvent[]> {
  try {
    return await readCompleteStream(eventStore, {
      streamId,
      maxEvents: MAX_AUTHORITY_HISTORY_EVENTS - 1,
    });
  } catch (error) {
    if (error instanceof EventStreamTooLongError) {
      fail(
        "history_too_long",
        `Consent activation authority stream '${streamId}' exceeded ${MAX_AUTHORITY_HISTORY_EVENTS} events.`,
      );
    }
    throw error;
  }
}

/**
 * THE authoritative read. State, active version, and the guard token are all
 * derived from one replay of the authority stream, so a caller cannot obtain a
 * version that describes a different moment than the state it was handed.
 *
 * A key with no events yields `never-activated` and the zero-event guard form
 * (`no_stream`) -- an unactivated key is a value with an identity, not a
 * missing row, which is what makes first activation guardable at all.
 */
export async function readConsentActivationAuthority(
  eventStore: EventStore,
  policyKey: string,
): Promise<ValidatedConsentActivationAuthoritySnapshot> {
  assertConsentCapablePolicyKey(policyKey);
  const streamId = consentActivationAuthorityStreamId(policyKey);
  const storedEvents = await readAuthorityEvents(eventStore, streamId);

  let state = initialConsentActivationAuthorityState;
  for (const storedEvent of storedEvents) {
    const event = decodeConsentActivationAuthorityEvent(storedEvent);
    if (event.data.policyKey !== policyKey) {
      fail(
        "policy_key_mismatch",
        `Consent activation authority stream '${streamId}' carries an event for '${event.data.policyKey}'.`,
      );
    }
    state = evolveConsentActivationAuthority(state, event);
  }

  const authorityVersion = storedEvents.at(-1)?.streamVersion ?? 0;

  return decodeConsentActivationAuthoritySnapshot(policyKey, {
    policyKey,
    streamId,
    registered: state.registered,
    status: state.status,
    isActive: state.status === "active",
    activeVersion: state.activeVersion,
    activeDocumentId: state.activeDocumentId,
    activationCount: state.activationCount,
    lastTransitionAt: state.lastTransitionAt,
    authorityVersion,
    guard: {
      policyKey,
      streamId,
      expectedVersion: authorityVersion === 0 ? "no_stream" : authorityVersion,
    },
  });
}
