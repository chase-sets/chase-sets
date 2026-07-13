/**
 * Source-context outcome-fact schema.
 *
 * Source contexts publish a completed outcome fact they own (checkout recovered,
 * order delivered, support request resolved, payout completed, ...). Customer
 * Feedback CONSUMES those facts and decides whether/when to issue an invitation.
 * The fact is the ONLY authoritative basis for an invitation — clients may never
 * claim workflow/entity provenance directly.
 *
 * No source context publishes this yet. The contract is defined here, at the
 * start gate, so journey slices publish exactly this shape and invitation and
 * analytics slices consume it without renegotiation.
 */
import { isProvenanceAuthoritative, type CsatWorkflowOutcomeCode } from "./workflow-outcomes";

/** A reference to the source-context entity whose completion the outcome describes. */
export type OutcomeSubjectRef = Readonly<{
  /** e.g. `order`, `return`, `support-request`, `payout`, `listing`, `offer`, `session`. */
  entityType: string;
  /** The source-context-owned id of that entity. Opaque to Customer Feedback. */
  entityId: string;
}>;

/** The role the subject played in the outcome, used for role-appropriate prompts. */
export type OutcomeSubjectKind = "buyer" | "seller" | "account" | "visitor";

/** Current outcome-fact schema version. Bump on any breaking payload change. */
export const csatOutcomeFactSchemaVersion = 1 as const;

/**
 * Raw publisher input. Source contexts may only supply server-derived values;
 * the factory below is the single runtime guard for the shared allow-list and
 * provenance ownership map.
 */
export type CsatOutcomeFactDraft = Omit<CsatOutcomeFactV1, "factSchemaVersion" | "outcomeCode"> &
  Readonly<{
    outcomeCode: string;
  }>;

/**
 * Versioned, server-authoritative outcome fact published by a source context.
 * Additive-optional evolution only: new fields must be optional so already
 * published facts remain valid on replay (the codebase replay-compat convention).
 */
export type CsatOutcomeFactV1 = Readonly<{
  /** Discriminator for forward-compatible versioning. */
  factSchemaVersion: 1;
  /** Stable outcome code from the Customer Feedback allow-list. */
  outcomeCode: CsatWorkflowOutcomeCode;
  /** The context that owns and published this fact (must match the code's owner). */
  sourceContext: string;
  /** The account that experienced the outcome and would receive the survey. */
  subjectAccountId: string;
  subjectKind: OutcomeSubjectKind;
  /** The source-context entity the outcome is about. */
  subject: OutcomeSubjectRef;
  /** When the outcome actually occurred, on the source context's clock. */
  outcomeOccurredAt: string;
  /**
   * Idempotency key for duplicate / out-of-order / reversed-then-reissued facts.
   * Customer Feedback dedupes invitations on this key (epic edge-case contract).
   */
  idempotencyKey: string;
  /** Optional correlation id for cross-context tracing. */
  correlationId?: string | null;
}>;

/** Build a versioned fact without permitting an unregistered or mis-owned code. */
export function createCsatOutcomeFactV1(input: CsatOutcomeFactDraft): CsatOutcomeFactV1 {
  const outcomeCode = input.outcomeCode;
  if (!isProvenanceAuthoritative(outcomeCode, input.sourceContext)) {
    throw new Error(
      `CSAT outcome fact provenance is not authoritative for '${input.outcomeCode}' from '${input.sourceContext}'.`,
    );
  }

  return {
    factSchemaVersion: csatOutcomeFactSchemaVersion,
    ...input,
    outcomeCode,
  };
}

/** The current outcome-fact type. Aliased so leaves import a version-neutral name. */
export type CsatOutcomeFact = CsatOutcomeFactV1;
