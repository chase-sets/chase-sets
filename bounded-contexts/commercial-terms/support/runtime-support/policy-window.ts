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

function windowsOverlap(
  left: Readonly<{ effectiveFrom: string; effectiveUntil: string | null }>,
  right: Readonly<{ effectiveFrom: string; effectiveUntil: string | null }>,
): boolean {
  const leftStart = Date.parse(left.effectiveFrom);
  const leftEnd = left.effectiveUntil === null ? Number.POSITIVE_INFINITY : Date.parse(left.effectiveUntil);
  const rightStart = Date.parse(right.effectiveFrom);
  const rightEnd = right.effectiveUntil === null ? Number.POSITIVE_INFINITY : Date.parse(right.effectiveUntil);
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
