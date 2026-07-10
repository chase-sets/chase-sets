import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core/domain";
import type { JsonValue } from "@chase-sets/primitives/json";

/**
 * Generic policy-document aggregate shared by every context that adopts the
 * platform-policy machinery. The aggregate itself stays value-shape agnostic
 * (`value` is opaque JSON); typed encode/decode boundaries live at the
 * `definePolicy` layer, not here, so this module can be shared by every
 * policy regardless of what it configures.
 */

export type PolicyDocumentStatus = "active" | "inactive";

export class PlatformPolicyDomainError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PlatformPolicyDomainError";
  }
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new PlatformPolicyDomainError(message);
  }
}

export function assertNever(value: never): never {
  throw new PlatformPolicyDomainError(`Unhandled variant: ${JSON.stringify(value)}`);
}

export type PolicyDocumentState = Readonly<{
  documentId: string | null;
  policyKey: string | null;
  status: PolicyDocumentStatus | null;
  value: JsonValue | null;
  effectiveFrom: string | null;
  effectiveUntil: string | null;
}>;

export const initialPolicyDocumentState: PolicyDocumentState = {
  documentId: null,
  policyKey: null,
  status: null,
  value: null,
  effectiveFrom: null,
  effectiveUntil: null,
};

export type CreatePolicyDocumentCommand = Readonly<{
  type: "CreatePolicyDocument";
  documentId: string;
  policyKey: string;
  contextName: string;
  schemaSummary: string;
  status: PolicyDocumentStatus;
  value: JsonValue;
  effectiveFrom: string;
  effectiveUntil: string | null;
  actorUserId: string;
}>;

export type RevisePolicyDocumentCommand = Readonly<{
  type: "RevisePolicyDocument";
  status: PolicyDocumentStatus;
  value: JsonValue;
  effectiveFrom: string;
  effectiveUntil: string | null;
  actorUserId: string;
}>;

export type PolicyDocumentCommand = CreatePolicyDocumentCommand | RevisePolicyDocumentCommand;

export type PolicyDocumentCreatedEvent = DomainEvent<
  "platform-policy.document.created",
  Readonly<{
    documentId: string;
    policyKey: string;
    contextName: string;
    schemaSummary: string;
    status: PolicyDocumentStatus;
    value: JsonValue;
    effectiveFrom: string;
    effectiveUntil: string | null;
    actorUserId: string;
  }>
>;

export type PolicyDocumentRevisedEvent = DomainEvent<
  "platform-policy.document.revised",
  Readonly<{
    documentId: string;
    policyKey: string;
    status: PolicyDocumentStatus;
    value: JsonValue;
    effectiveFrom: string;
    effectiveUntil: string | null;
    actorUserId: string;
  }>
>;

export type PolicyDocumentEvent = PolicyDocumentCreatedEvent | PolicyDocumentRevisedEvent;

export function normalizePolicyEffectiveWindow(effectiveFrom: string, effectiveUntil: string | null) {
  assert(!Number.isNaN(Date.parse(effectiveFrom)), "Policy effective-from must be an ISO timestamp.");
  assert(
    effectiveUntil === null || !Number.isNaN(Date.parse(effectiveUntil)),
    "Policy effective-until must be an ISO timestamp.",
  );
  assert(
    effectiveUntil === null || Date.parse(effectiveUntil) > Date.parse(effectiveFrom),
    "Policy effective-until must be after effective-from.",
  );

  return { effectiveFrom, effectiveUntil };
}

function normalizeNonEmpty(value: string, fieldName: string) {
  const normalized = value.trim();
  assert(normalized.length > 0, `${fieldName} is required.`);
  return normalized;
}

function normalizePolicyDocumentStatus(value: PolicyDocumentStatus) {
  assert(value === "active" || value === "inactive", "Policy document status must be active or inactive.");
  return value;
}

export const decidePolicyDocument: AggregateDecider<PolicyDocumentState, PolicyDocumentCommand, PolicyDocumentEvent> = (
  state,
  command,
) => {
  switch (command.type) {
    case "CreatePolicyDocument": {
      assert(state.documentId === null, "Policy document has already been created.");
      const window = normalizePolicyEffectiveWindow(command.effectiveFrom, command.effectiveUntil);
      return [
        {
          type: "platform-policy.document.created",
          data: {
            documentId: normalizeNonEmpty(command.documentId, "Policy document id"),
            policyKey: normalizeNonEmpty(command.policyKey, "Policy key"),
            contextName: normalizeNonEmpty(command.contextName, "Policy context name"),
            schemaSummary: normalizeNonEmpty(command.schemaSummary, "Policy schema summary"),
            status: normalizePolicyDocumentStatus(command.status),
            value: command.value,
            effectiveFrom: window.effectiveFrom,
            effectiveUntil: window.effectiveUntil,
            actorUserId: normalizeNonEmpty(command.actorUserId, "Actor user id"),
          },
        },
      ];
    }
    case "RevisePolicyDocument": {
      assert(state.documentId !== null, "Policy document must be created before it can be revised.");
      const window = normalizePolicyEffectiveWindow(command.effectiveFrom, command.effectiveUntil);
      return [
        {
          type: "platform-policy.document.revised",
          data: {
            documentId: state.documentId,
            policyKey: state.policyKey as string,
            status: normalizePolicyDocumentStatus(command.status),
            value: command.value,
            effectiveFrom: window.effectiveFrom,
            effectiveUntil: window.effectiveUntil,
            actorUserId: normalizeNonEmpty(command.actorUserId, "Actor user id"),
          },
        },
      ];
    }
    default:
      throw assertNever(command);
  }
};

export const evolvePolicyDocument: AggregateEvolver<PolicyDocumentState, PolicyDocumentEvent> = (state, event) => {
  switch (event.type) {
    case "platform-policy.document.created":
      return {
        documentId: event.data.documentId,
        policyKey: event.data.policyKey,
        status: event.data.status,
        value: event.data.value,
        effectiveFrom: event.data.effectiveFrom,
        effectiveUntil: event.data.effectiveUntil,
      };
    case "platform-policy.document.revised":
      return {
        ...state,
        status: event.data.status,
        value: event.data.value,
        effectiveFrom: event.data.effectiveFrom,
        effectiveUntil: event.data.effectiveUntil,
      };
    default:
      throw assertNever(event);
  }
};
