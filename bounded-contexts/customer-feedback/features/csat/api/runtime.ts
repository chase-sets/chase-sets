import { createHash } from "node:crypto";
import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createId, createInternalId } from "@chase-sets/primitives/typed-ids";
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
import { buildCsatInvitationProjectionHandlers } from "../read-model/projection";
import { getCsatInvitationByPublicReference, getCsatInvitationStreamIdByPublicReference } from "../read-model/queries";

export type CsatInvitationRuntimeDeps = Readonly<{
  eventStore: EventStore;
  db: PgQueryable;
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
    executeByPublicReference: async (command: RedeemCsatInvitationCommand, context: EventStoreContext) => {
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
    },
    getByPublicReference: getCsatInvitationByPublicReference.bind(null, deps.db),
    projectors: [
      createProjectionHandlerSet({
        projectionName: "customer-feedback-csat-invitation-projection",
        handlers: buildCsatInvitationProjectionHandlers(deps.db),
      }),
    ] as readonly ProjectionHandlerSet[],
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
