import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core/domain";
import { PlatformPolicyDomainError, type PolicyDocumentStatus } from "@chase-sets/platform-policy/domain";

export type CommercialTermsPolicyWindow = Readonly<{
  documentId: string;
  status: PolicyDocumentStatus;
  effectiveFrom: string;
  effectiveUntil: string | null;
}>;

export type CommercialTermsPolicyWindowState = Readonly<{
  documents: Readonly<Record<string, CommercialTermsPolicyWindow>>;
}>;

export const initialCommercialTermsPolicyWindowState: CommercialTermsPolicyWindowState = {
  documents: {},
};

export type RecordCommercialTermsPolicyWindowCommand = Readonly<{
  type: "RecordCommercialTermsPolicyWindow";
  documentId: string;
  status: PolicyDocumentStatus;
  effectiveFrom: string;
  effectiveUntil: string | null;
  overlapMessage: (overlapDocumentId: string) => string;
}>;

export type CommercialTermsPolicyWindowRecordedEvent = DomainEvent<
  "commercial-terms.policy-window.recorded",
  Readonly<{
    documentId: string;
    status: PolicyDocumentStatus;
    effectiveFrom: string;
    effectiveUntil: string | null;
  }>
>;

/**
 * Parses an effective-window bound to an epoch millisecond value, failing
 * closed (throwing rather than returning `NaN`) when the bound does not
 * parse. `NaN` comparisons are always false, so an unparseable bound left
 * unchecked would silently evade overlap detection instead of blocking it.
 */
function parseEffectiveBound(value: string, fieldName: string): number {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new PlatformPolicyDomainError(`Policy window ${fieldName} is not a parseable ISO timestamp: '${value}'.`);
  }
  return parsed;
}

function windowsOverlap(
  left: Readonly<{ effectiveFrom: string; effectiveUntil: string | null }>,
  right: Readonly<{ effectiveFrom: string; effectiveUntil: string | null }>,
): boolean {
  const leftStart = parseEffectiveBound(left.effectiveFrom, "effectiveFrom");
  const leftEnd =
    left.effectiveUntil === null
      ? Number.POSITIVE_INFINITY
      : parseEffectiveBound(left.effectiveUntil, "effectiveUntil");
  const rightStart = parseEffectiveBound(right.effectiveFrom, "effectiveFrom");
  const rightEnd =
    right.effectiveUntil === null
      ? Number.POSITIVE_INFINITY
      : parseEffectiveBound(right.effectiveUntil, "effectiveUntil");
  return leftStart < rightEnd && rightStart < leftEnd;
}

export const decideCommercialTermsPolicyWindow: AggregateDecider<
  CommercialTermsPolicyWindowState,
  RecordCommercialTermsPolicyWindowCommand,
  CommercialTermsPolicyWindowRecordedEvent
> = (state, command) => {
  if (command.status === "active") {
    const overlap = Object.values(state.documents).find(
      (document) =>
        document.documentId !== command.documentId && document.status === "active" && windowsOverlap(document, command),
    );
    if (overlap) {
      throw new PlatformPolicyDomainError(command.overlapMessage(overlap.documentId));
    }
  }

  return [
    {
      type: "commercial-terms.policy-window.recorded",
      data: {
        documentId: command.documentId,
        status: command.status,
        effectiveFrom: command.effectiveFrom,
        effectiveUntil: command.effectiveUntil,
      },
    },
  ];
};

export const evolveCommercialTermsPolicyWindow: AggregateEvolver<
  CommercialTermsPolicyWindowState,
  CommercialTermsPolicyWindowRecordedEvent
> = (state, event) => ({
  documents: {
    ...state.documents,
    [event.data.documentId]: event.data,
  },
});

export function commercialTermsPolicyWindowStreamId(policyKey: string): string {
  return `commercial-terms.policy-window-${policyKey}`;
}
