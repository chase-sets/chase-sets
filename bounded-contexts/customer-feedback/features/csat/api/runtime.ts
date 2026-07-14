import { createHash } from "node:crypto";
import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createId, createInternalId } from "@chase-sets/primitives/typed-ids";
import type {
  CsatAdminExportAudit,
  CsatAdminQueuePage,
  CsatAdminQueueQuery,
  CsatAnalyticsQuery,
  CsatAnalyticsSnapshot,
  CsatProjectionReadiness,
} from "./analytics-contract";
import {
  decideCsatInvitation,
  evolveCsatInvitation,
  initialCsatInvitationState,
  CsatInvitationDecisionError,
  type CsatInvitationCommand,
} from "../domain/invitation-decider";
import type { CustomerFeedbackInvitationEvent } from "../domain/invitation";
import type { CsatOutcomeFactV1 } from "../domain/outcome-fact";
import type { CsatSamplingCooldownClaimedEvent, CsatSamplingPolicyV1 } from "../domain/sampling";
import type { CsatRatingValue, SurveyVersionId } from "../domain/survey";
import { buildCsatAnalyticsProjectionHandlers } from "../read-model/analytics-projection";
import { readCsatAnalytics } from "../read-model/analytics-query";
import { buildCsatInvitationProjectionHandlers } from "../read-model/projection";
import {
  getCsatInvitationByPublicReference,
  getCsatInvitationStreamIdByPublicReference,
  type CsatInvitationPageRow,
} from "../read-model/queries";
import { listCsatAdminQueue } from "../read-model/queries";

export type CsatInvitationRuntimeDeps = Readonly<{
  eventStore: EventStore;
  db: PgQueryable;
}>;

export type CsatAdminReadPort = Readonly<{
  readAdminAnalytics: (query: CsatAnalyticsQuery) => Promise<CsatAnalyticsSnapshot>;
  listAdminQueue: (query: CsatAdminQueueQuery) => Promise<CsatAdminQueuePage>;
  recordAdminExport: (audit: CsatAdminExportAudit) => Promise<void>;
}>;

export type IssueCsatInvitationParams = Readonly<{
  fact: CsatOutcomeFactV1;
  policy: CsatSamplingPolicyV1;
  subjectEligible: boolean;
  consentAllowed: boolean;
  trafficKind: "customer" | "automated" | "test";
  evaluatedAt?: string;
}>;

export type RedeemCsatInvitationCommand = Exclude<
  CsatInvitationCommand,
  { type: "EvaluateCsatOutcomeFact" | "ExpireCsatInvitation" | "RevokeCsatInvitation" }
>;

export type RecordCsatPresentationParams = Readonly<{
  publicReference: RedeemCsatInvitationCommand["publicReference"];
  subjectAccountId: string;
  presentedAt?: string;
}>;

export type RecordCsatDismissalParams = Readonly<{
  publicReference: RedeemCsatInvitationCommand["publicReference"];
  subjectAccountId: string;
  dismissedAt?: string;
}>;

export type RecordCsatSubmissionParams = Readonly<{
  publicReference: RedeemCsatInvitationCommand["publicReference"];
  subjectAccountId: string;
  rating: CsatRatingValue;
  comment: string | null;
  followUpConsent: boolean;
  followUpConsentVersion: string;
  followUpConsentAt: string | null;
  submissionIdempotencyKey: string;
  submittedAt?: string;
}>;

const cooldownCodec = createPassthroughDomainEventCodec<CsatSamplingCooldownClaimedEvent>();

export function createCsatInvitationRuntime(deps: CsatInvitationRuntimeDeps) {
  const invitationCodec = createPassthroughDomainEventCodec<CustomerFeedbackInvitationEvent>();
  const { commandHandler, repository } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: invitationCodec,
    initialState: () => initialCsatInvitationState,
    evolve: evolveCsatInvitation,
    decide: decideCsatInvitation,
  });
  const appendToStreams = deps.eventStore.appendToStreams;
  if (!appendToStreams) {
    throw new Error("CSAT invitation issuance requires atomic multi-stream append support.");
  }

  const executeByPublicReference = async (command: RedeemCsatInvitationCommand, context: EventStoreContext) => {
    const streamId = await getCsatInvitationStreamIdByPublicReference(
      deps.db,
      command.publicReference,
      command.subjectAccountId,
    );
    if (!streamId) {
      throw new CsatInvitationDecisionError("invitation-not-found", "Invitation does not exist.", {
        state: null,
        outcomeCode: null,
      });
    }
    const result = await commandHandler({ streamId, command, context });
    return requireResult(result.state.invitation);
  };

  const loadAuthoritativeInvitation = async (
    publicReference: RedeemCsatInvitationCommand["publicReference"],
    subjectAccountId: string,
  ): Promise<CsatInvitationPageRow> => {
    const invitation = await getCsatInvitationByPublicReference(deps.db, publicReference, subjectAccountId);
    if (!invitation) {
      throw new CsatInvitationDecisionError("invitation-not-found", "Invitation does not exist.", {
        state: null,
        outcomeCode: null,
      });
    }
    return invitation;
  };

  return {
    commandHandler,
    issueFromOutcomeFact: async (params: IssueCsatInvitationParams, context: EventStoreContext) => {
      const streamId = csatInvitationStreamId(params.fact.sourceContext, params.fact.idempotencyKey);
      const cooldownStreamId = csatCooldownStreamId(params.fact.subjectAccountId, params.fact.outcomeCode);

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const existing = await repository.load(streamId);
        if (existing.state.invitation) return existing.state.invitation;

        const cooldown = await loadCooldownClaim(deps.eventStore, cooldownStreamId);
        const evaluatedAt = params.evaluatedAt ?? new Date().toISOString();
        const command: CsatInvitationCommand = {
          type: "EvaluateCsatOutcomeFact",
          invitationId: createId("csatinv"),
          publicReference: createInternalId("csatref"),
          fact: params.fact,
          policy: params.policy,
          controls: {
            subjectEligible: params.subjectEligible,
            consentAllowed: params.consentAllowed,
            trafficKind: params.trafficKind,
            lastIssuedAt: cooldown.lastIssuedAt,
          },
          evaluatedAt,
        };
        const events = decideCsatInvitation(initialCsatInvitationState, command);
        const issued = events.some((event) => event.type === "customer-feedback.invitation.issued");
        const claim: CsatSamplingCooldownClaimedEvent = {
          type: "customer-feedback.sampling.cooldown-claimed",
          data: {
            eventSchemaVersion: 1,
            subjectAccountId: params.fact.subjectAccountId,
            outcomeCode: params.fact.outcomeCode,
            outcomeIdempotencyKey: params.fact.idempotencyKey,
            issuedAt: evaluatedAt,
          },
        };

        try {
          await appendToStreams([
            {
              streamId,
              expectedVersion: "no_stream",
              context,
              events: events.map(invitationCodec.encode),
            },
            ...(issued
              ? [
                  {
                    streamId: cooldownStreamId,
                    expectedVersion: cooldown.version === 0 ? ("no_stream" as const) : cooldown.version,
                    context,
                    events: [cooldownCodec.encode(claim)],
                  },
                ]
              : []),
          ]);
          return requireResult(events.reduce(evolveCsatInvitation, initialCsatInvitationState).invitation);
        } catch (error) {
          if (!isConcurrencyConflict(error)) throw error;
        }
      }

      throw new Error("CSAT invitation issuance exceeded its concurrency retry budget.");
    },
    executeByPublicReference,
    recordPresentation: async (params: RecordCsatPresentationParams, context: EventStoreContext) => {
      const invitation = await loadAuthoritativeInvitation(params.publicReference, params.subjectAccountId);
      return executeByPublicReference(
        {
          type: "PresentCsatInvitation",
          publicReference: params.publicReference,
          subjectAccountId: params.subjectAccountId,
          surveyVersion: surveyVersionFromRow(invitation),
          actedAt: params.presentedAt ?? new Date().toISOString(),
        },
        context,
      );
    },
    recordDismissal: async (params: RecordCsatDismissalParams, context: EventStoreContext) => {
      const invitation = await loadAuthoritativeInvitation(params.publicReference, params.subjectAccountId);
      return executeByPublicReference(
        {
          type: "DismissCsatInvitation",
          publicReference: params.publicReference,
          subjectAccountId: params.subjectAccountId,
          surveyVersion: surveyVersionFromRow(invitation),
          actedAt: params.dismissedAt ?? new Date().toISOString(),
        },
        context,
      );
    },
    recordSubmission: async (params: RecordCsatSubmissionParams, context: EventStoreContext) => {
      const invitation = await loadAuthoritativeInvitation(params.publicReference, params.subjectAccountId);
      return executeByPublicReference(
        {
          type: "SubmitCsatSurvey",
          publicReference: params.publicReference,
          subjectAccountId: params.subjectAccountId,
          surveyVersion: surveyVersionFromRow(invitation),
          rating: params.rating,
          comment: params.comment,
          followUpConsent: params.followUpConsent,
          followUpConsentVersion: params.followUpConsentVersion,
          followUpConsentAt: params.followUpConsentAt,
          submissionIdempotencyKey: params.submissionIdempotencyKey,
          submittedAt: params.submittedAt ?? new Date().toISOString(),
        },
        context,
      );
    },
    readAnalytics: (query: CsatAnalyticsQuery, readiness: CsatProjectionReadiness) =>
      readCsatAnalytics(deps.db, query, readiness),
    readAdminAnalytics: async (query: CsatAnalyticsQuery) =>
      readCsatAnalytics(deps.db, query, await readCsatProjectionReadiness(deps.db, query.asOf)),
    listAdminQueue: (query: CsatAdminQueueQuery) => listCsatAdminQueue(deps.db, query),
    recordAdminExport: async (audit: CsatAdminExportAudit) => {
      await deps.db.query(
        `INSERT INTO customer_feedback_csat_export_audits
          (export_id, actor_id, filters, started_at, completed_at, row_count, result)
         VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)`,
        [
          createId("cse"),
          audit.actorId,
          JSON.stringify(audit.filters),
          audit.startedAt,
          audit.completedAt,
          audit.rowCount,
          audit.result,
        ],
      );
    },
    getByPublicReference: getCsatInvitationByPublicReference.bind(null, deps.db),
    projectors: [
      createProjectionHandlerSet({
        projectionName: "customer-feedback-csat-invitation-projection",
        handlers: buildCsatInvitationProjectionHandlers(deps.db),
      }),
      createProjectionHandlerSet({
        projectionName: "customer-feedback-csat-analytics-projection",
        handlers: buildCsatAnalyticsProjectionHandlers(deps.db),
      }),
    ] as readonly ProjectionHandlerSet[],
  };
}

async function readCsatProjectionReadiness(db: PgQueryable, asOf: string): Promise<CsatProjectionReadiness> {
  const result = await db.query<{ updated_at: string }>(
    `SELECT updated_at::text AS updated_at
     FROM event_projection_checkpoints
     WHERE projector_name = $1`,
    ["customer-feedback-csat-analytics-projection"],
  );
  const lastProjectedAt = result.rows[0]?.updated_at ?? null;
  const projectionLagMs = lastProjectedAt === null ? null : Math.max(0, Date.parse(asOf) - Date.parse(lastProjectedAt));
  return {
    complete: lastProjectedAt !== null,
    stale: projectionLagMs !== null && projectionLagMs > 15 * 60 * 1000,
    lastProjectedAt,
    projectionLagMs,
    rejectedEventCount: 0,
  };
}

function surveyVersionFromRow(row: CsatInvitationPageRow): SurveyVersionId {
  return {
    surveyKind: row.survey_kind as SurveyVersionId["surveyKind"],
    surveyVersion: row.survey_version,
    questionVersion: row.question_version,
  };
}

export function csatInvitationStreamId(sourceContext: string, outcomeIdempotencyKey: string): string {
  return `customer-feedback.csat-invitation-${stableDigest(sourceContext, outcomeIdempotencyKey)}`;
}

export function csatCooldownStreamId(subjectAccountId: string, outcomeCode: string): string {
  return `customer-feedback.csat-cooldown-${stableDigest(subjectAccountId, outcomeCode)}`;
}

async function loadCooldownClaim(
  eventStore: EventStore,
  streamId: string,
): Promise<Readonly<{ version: number; lastIssuedAt: string | null }>> {
  let fromVersion = 1;
  let version = 0;
  let lastIssuedAt: string | null = null;
  for (;;) {
    const page = await eventStore.readStream({ streamId, fromVersion, limit: 500 });
    for (const stored of page) {
      const event = cooldownCodec.decode(stored);
      version = stored.streamVersion;
      lastIssuedAt = event.data.issuedAt;
    }
    if (page.length < 500) return { version, lastIssuedAt };
    fromVersion = page[page.length - 1].streamVersion + 1;
  }
}

function stableDigest(first: string, second: string): string {
  return createHash("sha256").update(first).update("\0").update(second).digest("hex");
}

function isConcurrencyConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "concurrency_conflict";
}

function requireResult<T>(value: T | null): T {
  if (value === null) throw new Error("CSAT invitation command completed without invitation state.");
  return value;
}
