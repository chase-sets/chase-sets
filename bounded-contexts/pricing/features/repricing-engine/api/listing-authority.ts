import { isDeepStrictEqual } from "node:util";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { AppendToStreamInput, EventStoreContext } from "@chase-sets/event-core/storage";
import {
  requireListingAuthorityPrincipal,
  type ListingAuthorityConsumerPort,
  type ListingAuthorityOperation,
  type ListingAuthorityStandingAuthorityPort,
} from "@chase-sets/event-core/listing-authority";
import type {
  MarketplaceListingPriceDecision,
  MarketplaceListingPriceTarget,
} from "@chase-sets/event-core/public-event-payloads";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { toJsonValue, type JsonObject } from "@chase-sets/primitives/json";
import { createListingAuthorityParticipant } from "@chase-sets/platform-runtime/listing-authority-participant";
import { createListingAuthorityWriter } from "@chase-sets/platform-runtime/listing-authority-writer";
import { createListingAuthorityRecovery } from "@chase-sets/platform-runtime/listing-authority-recovery";
import { planRepricingRound } from "../domain/round";
import { readPricingAuthorityInputs, type PricingAuthorityInputRequest } from "./listing-authority-inputs";
import { pricingAuthorityDigest, pricingAuthorityResources as resource } from "./listing-authority-resources";
import { createPricingAuthorityObservations, pricingObservationResources } from "./listing-authority-observations";
import type { TransportEvent } from "@chase-sets/event-core/transport";

export type PricingEvaluatedDecision = Extract<MarketplaceListingPriceDecision, { kind: "pricing-evaluation" }>;
export type PricingEvaluationRequest = PricingAuthorityInputRequest &
  Readonly<{
    evaluationId: string;
    target: MarketplaceListingPriceTarget;
    basePriceRevision: number;
  }>;

/** Pricing-owned admission against the EXISTING daily counter, with durable per-evaluation idempotency. */
export type PricingEvaluationBudget = Readonly<{
  reserve(input: Readonly<{ evaluationId: string; accountId: string; day: string; limit: number }>): Promise<boolean>;
  inspect(
    evaluationId: string,
  ): Promise<Readonly<{ accountId: string; day: string; status: "reserved" | "released" }> | null>;
  release(evaluationId: string): Promise<void>;
}>;

export type PricingListingAuthorityPorts = Readonly<{
  consumer(operation: ListingAuthorityOperation): ListingAuthorityConsumerPort;
}>;

type RecordedEvaluation = Readonly<{
  request: PricingEvaluationRequest;
  tenantId: string;
  actorId: string;
  capturedAt: string;
  validBefore: string;
  listingRevision: number;
  inventoryItemId: string;
  quantity: number;
  pair: Readonly<{ amount: string; currencyCode: string }>;
  decision: PricingEvaluatedDecision;
  resources: readonly string[];
  revisions: readonly Readonly<{ resourceId: string; revision: string }>[];
  evidenceRevision: string;
}>;

export class PricingAuthorityMutationPendingError extends Error {
  constructor(
    public readonly inputs: readonly AppendToStreamInput[],
    options: ErrorOptions,
  ) {
    super("Pricing mutation outcome is unresolved; resume the retained write identity.", options);
    this.name = "PricingAuthorityMutationPendingError";
  }
}

type EvaluationSelector = Pick<PricingEvaluationRequest, "evaluationId" | "accountId" | "listingId" | "target">;
const evaluationStream = (request: EvaluationSelector, tenantId: string) =>
  `pricing.evaluated-decision-${pricingAuthorityDigest([tenantId, request.accountId, request.listingId, request.target, request.evaluationId])}`;
const payload = (value: unknown) => toJsonValue(value) as JsonObject;

export function createPricingListingAuthority(
  deps: Readonly<{ eventStore: EventStore; db: PgQueryable; budget: PricingEvaluationBudget; now?: () => Date }>,
  ports: PricingListingAuthorityPorts,
) {
  const now = () => (deps.now?.() ?? new Date()).toISOString();
  async function readEvaluation(request: EvaluationSelector, tenantId: string): Promise<RecordedEvaluation | null> {
    const history = await readCompleteStream(deps.eventStore, { streamId: evaluationStream(request, tenantId) });
    if (!history.length) return null;
    if (history.length !== 1 || history[0]!.eventType !== "pricing.evaluated-decision.recorded")
      throw new Error("Pricing decision history is not an immutable evaluation.");
    const record = history[0]!.payload as unknown as RecordedEvaluation;
    if (
      evaluationStream(record.request, record.tenantId) !== evaluationStream(request, tenantId) ||
      record.tenantId !== history[0]!.tenantId ||
      record.request.accountId !== history[0]!.forAccountId ||
      record.actorId !== history[0]!.performedByUserId
    )
      throw new Error("Pricing decision history binding mismatch.");
    return record;
  }

  async function evaluate(request: PricingEvaluationRequest, context: EventStoreContext, dryRun = false) {
    if (
      !request.evaluationId ||
      request.evaluationId.length > 200 ||
      context.audit.forAccountId !== request.accountId ||
      !Number.isSafeInteger(request.basePriceRevision) ||
      request.basePriceRevision < 1 ||
      (request.target.kind === "channel-connection" && !request.target.connectionId)
    )
      throw new Error("Invalid Pricing evaluation identity or target.");
    if (!dryRun) {
      const prior = await readEvaluation(request, context.tenantId);
      if (prior) {
        if (
          !isDeepStrictEqual(prior.request, request) ||
          prior.tenantId !== context.tenantId ||
          prior.actorId !== context.audit.performedByUserId
        )
          throw new Error("Pricing evaluation identity conflict.");
        return prior;
      }
    }
    const capturedAt = now();
    const inputs = await readPricingAuthorityInputs(deps, request, capturedAt);
    const listing = inputs.round.listings[0]!;
    const evaluation = planRepricingRound(inputs.round, capturedAt, inputs.enginePolicy)[0]!;
    if (
      evaluation.action !== "update-price" ||
      !evaluation.targetPriceAmount ||
      !listing.priceCurrencyCode ||
      !listing.inventoryItemId
    )
      throw new Error("Pricing evaluation does not authorize a price change.");
    const decision: PricingEvaluatedDecision = {
      kind: "pricing-evaluation",
      evaluationId: request.evaluationId,
      evaluationRevision: "1",
      policyId: inputs.policyId,
      policyRevision: inputs.policyRevision,
      // The existing evaluator has no goal/curve/economics computation. Do not invent one for #8349.
      goal: null,
      curveEvidenceRefs: [],
      economicsSourceRevision: null,
      economicsOverrideRevision: null,
      inputEvidenceRefs: [inputs.evidenceRevision],
      basePriceRevision: request.basePriceRevision,
      standingAuthorizationId: inputs.policyId,
      standingAuthorizationRevision: inputs.policyRevision,
    };
    const record: RecordedEvaluation = {
      request,
      tenantId: context.tenantId,
      actorId: context.audit.performedByUserId,
      capturedAt,
      validBefore: inputs.validBefore,
      listingRevision: listing.listingVersion,
      inventoryItemId: listing.inventoryItemId,
      quantity: listing.quantityCap,
      pair: { amount: evaluation.targetPriceAmount, currencyCode: listing.priceCurrencyCode },
      decision,
      resources: [...inputs.resources, resource.decision(evaluationStream(request, context.tenantId))].sort(),
      revisions: inputs.revisions,
      evidenceRevision: inputs.evidenceRevision,
    };
    if (dryRun) return record;
    if (
      !(await deps.budget.reserve({
        evaluationId: evaluationStream(request, context.tenantId),
        accountId: request.accountId,
        day: capturedAt.slice(0, 10),
        limit: listing.maxChangesPerDay,
      }))
    )
      throw new Error("Pricing daily change budget exhausted.");
    try {
      await deps.eventStore.appendToStreams!([
        ...inputs.revisions.map(({ resourceId, revision }) => ({
          streamId: resourceId,
          expectedVersion: Number(revision),
          events: [],
          context,
        })),
        {
          streamId: evaluationStream(request, context.tenantId),
          expectedVersion: 0,
          context,
          events: [{ eventType: "pricing.evaluated-decision.recorded", payload: payload(record) }],
        },
      ]);
    } catch (error) {
      const retained = await readEvaluation(request, context.tenantId);
      if (
        !retained ||
        !isDeepStrictEqual(retained.request, request) ||
        retained.tenantId !== context.tenantId ||
        retained.actorId !== context.audit.performedByUserId
      )
        throw error;
      return retained;
    }
    return record;
  }

  function decisionOf(operation: ListingAuthorityOperation): PricingEvaluatedDecision {
    const decision = operation.command.decision as unknown as PricingEvaluatedDecision | undefined;
    if (operation.kind !== "accept-price" || decision?.kind !== "pricing-evaluation" || !decision.evaluationId)
      throw new Error("Pricing authority requires an exact evaluated-price decision.");
    return decision;
  }
  const selector = (operation: ListingAuthorityOperation): EvaluationSelector => ({
    evaluationId: decisionOf(operation).evaluationId,
    accountId: operation.accountId,
    listingId: operation.listingId,
    target: operation.target,
  });
  const participant = createListingAuthorityParticipant({
    eventStore: deps.eventStore,
    participant: { owner: "pricing", purpose: "evaluated-price" },
    resourceScope: "owner",
    consumer: ports.consumer,
    resources: async (operation) => {
      const record = await readEvaluation(selector(operation), operation.tenantId);
      if (!record) throw new Error("Pricing evaluation is not durably recorded before acceptance.");
      return record.resources;
    },
    validate: async (operation, context) => {
      const decision = decisionOf(operation);
      const record = await readEvaluation(selector(operation), operation.tenantId);
      if (
        !record ||
        !isDeepStrictEqual(record.decision, decision) ||
        !isDeepStrictEqual(record.request.target, operation.target) ||
        !isDeepStrictEqual(record.pair, operation.subject.pair) ||
        record.tenantId !== operation.tenantId ||
        record.request.accountId !== operation.accountId ||
        record.request.listingId !== operation.listingId ||
        record.request.catalogItemId !== operation.subject.catalogItemId ||
        record.request.productId !== operation.subject.productId ||
        record.inventoryItemId !== operation.subject.inventoryItemId ||
        record.quantity !== operation.subject.quantity ||
        record.listingRevision !== operation.expectedListingRevision ||
        record.actorId !== operation.actor.userId
      )
        throw new Error("Pricing decision does not bind this exact operation, target, pair and subject.");
      if (Date.parse(record.validBefore) <= Date.parse(now())) throw new Error("Pricing decision validity ended.");
      const principal = requireListingAuthorityPrincipal(context);
      if (!isDeepStrictEqual(principal, operation.principal)) throw new Error("Pricing principal binding mismatch.");
      if (
        principal.kind === "standing-system" &&
        (principal.admittingOwner !== "pricing" ||
          principal.userId !== "usr_pricing_system" ||
          principal.authorityId !== decision.standingAuthorizationId ||
          principal.authorityRevision !== decision.standingAuthorizationRevision ||
          !isDeepStrictEqual(principal.scopeCeiling, ["listings.manage"]))
      )
        throw new Error("Pricing standing authority does not admit this operation.");
      const budget = await deps.budget.inspect(evaluationStream(record.request, operation.tenantId));
      if (
        budget?.status !== "reserved" ||
        budget.accountId !== operation.accountId ||
        budget.day !== record.capturedAt.slice(0, 10)
      )
        throw new Error("Pricing evaluation has no retained daily budget admission.");
      const current = await readPricingAuthorityInputs(deps, record.request, record.capturedAt);
      if (
        current.evidenceRevision !== record.evidenceRevision ||
        current.policyId !== decision.policyId ||
        current.policyRevision !== decision.policyRevision ||
        !isDeepStrictEqual(
          [...current.resources, resource.decision(evaluationStream(record.request, operation.tenantId))].sort(),
          record.resources,
        )
      )
        throw new Error("Pricing evaluation inputs or assignment changed.");
      const validBefore = [record.validBefore, operation.prepareBefore, principal.validBefore].sort(
        (a, b) => Date.parse(a) - Date.parse(b),
      )[0]!;
      return {
        value: {
          decision: toJsonValue(decision),
          pair: toJsonValue(record.pair),
          target: toJsonValue(record.request.target),
        },
        resources: record.resources,
        validBefore,
        sourceRevisions: [
          ...record.revisions,
          { resourceId: evaluationStream(record.request, operation.tenantId), revision: "1" },
          { resourceId: "pricing-input-evidence", revision: record.evidenceRevision },
        ],
        localAppends: [
          ...record.revisions.map(({ resourceId, revision }) => ({
            streamId: resourceId,
            expectedVersion: Number(revision),
            events: [],
            context,
          })),
          { streamId: evaluationStream(record.request, operation.tenantId), expectedVersion: 1, context, events: [] },
        ],
      };
    },
    settlementAppends: async (operation, status) => {
      if (status === "released") await deps.budget.release(evaluationStream(selector(operation), operation.tenantId));
      return [];
    },
  });
  // One evaluated decision admits one exact consumer identity, including after abort.
  // This immutable claim does not change any policy/evidence predicate and grants no authority itself.
  const source = {
    ...participant,
    async prepare(operation: ListingAuthorityOperation, context: EventStoreContext) {
      const principal = requireListingAuthorityPrincipal(context);
      if (!isDeepStrictEqual(principal, operation.principal)) throw new Error("Pricing principal binding mismatch.");
      const id = decisionOf(operation).evaluationId;
      const evaluated = await readEvaluation(selector(operation), operation.tenantId);
      if (
        !evaluated ||
        !isDeepStrictEqual(evaluated.decision, decisionOf(operation)) ||
        evaluated.tenantId !== operation.tenantId ||
        evaluated.request.accountId !== operation.accountId ||
        evaluated.actorId !== operation.actor.userId ||
        evaluated.request.listingId !== operation.listingId ||
        !isDeepStrictEqual(evaluated.request.target, operation.target) ||
        !isDeepStrictEqual(evaluated.pair, operation.subject.pair)
      )
        throw new Error("Pricing decision does not bind this consumer.");
      const streamId = `${evaluationStream(selector(operation), operation.tenantId)}-consumer`;
      const retained = await readCompleteStream(deps.eventStore, { streamId });
      if (retained.length) {
        if (
          retained.length !== 1 ||
          retained[0]!.eventType !== "pricing.evaluated-decision.consumer-bound" ||
          !isDeepStrictEqual(retained[0]!.payload.operation, operation)
        )
          throw new Error("Pricing decision already binds another consumer.");
      } else {
        const consumer = await ports.consumer(operation).inspect(operation);
        if (consumer.status !== "pending" || !isDeepStrictEqual(consumer.operation, operation))
          throw new Error("Pricing requires the original pending consumer.");
        try {
          await deps.eventStore.appendToStream({
            streamId,
            expectedVersion: 0,
            context,
            events: [{ eventType: "pricing.evaluated-decision.consumer-bound", payload: payload({ operation }) }],
          });
        } catch (error) {
          const claim = await readCompleteStream(deps.eventStore, { streamId });
          if (
            claim.length !== 1 ||
            claim[0]!.eventType !== "pricing.evaluated-decision.consumer-bound" ||
            !isDeepStrictEqual(claim[0]!.payload.operation, operation)
          )
            throw error;
        }
      }
      return participant.prepare(operation, context);
    },
  };
  const writer = createListingAuthorityWriter({
    eventStore: deps.eventStore,
    source,
    owner: "pricing",
    resources: async (inputs) => {
      const affected = new Set<string>();
      for (const input of inputs) {
        if (!input.events.length) continue;
        const history = await readCompleteStream(deps.eventStore, { streamId: input.streamId });
        if (input.events.some((event) => event.eventType === "pricing.evaluation-input.observed")) {
          for (const id of pricingObservationResources(
            [...history, ...input.events].map((event) => event.payload.event as unknown as TransportEvent),
          ))
            affected.add(id);
        }
        for (const event of [...history.slice(0, 1), ...input.events]) {
          if (event.eventType.startsWith("pricing.repricing-policy.")) {
            const accountId = event.payload.accountId ?? history[0]?.payload.accountId;
            if (typeof accountId !== "string") throw new Error("Pricing policy writer lost account authority.");
            affected.add(resource.account(accountId));
          } else if (event.eventType.startsWith("pricing.repricing-halt.")) {
            const prefix = "pricing.repricing-halt-";
            if (!input.streamId.startsWith(prefix)) throw new Error("Pricing Halt stream identity mismatch.");
            affected.add(resource.account(input.streamId.slice(prefix.length)));
          } else if (event.eventType.startsWith("platform-policy.document.")) {
            const policyKey = event.payload.policyKey ?? history[0]?.payload.policyKey;
            if (typeof policyKey !== "string") throw new Error("Pricing platform policy identity missing.");
            affected.add(resource.policy(policyKey));
          } else if (
            event.eventType === "pricing.market-price.estimated" ||
            event.eventType === "pricing.market-price.invalidated"
          ) {
            const { catalogItemId, productId } = event.payload;
            if (typeof catalogItemId !== "string" || typeof productId !== "string")
              throw new Error("Pricing estimate Product missing.");
            affected.add(resource.product(catalogItemId, productId));
          }
        }
      }
      return [...affected];
    },
  });
  async function append(inputs: readonly AppendToStreamInput[]) {
    try {
      return await writer.eventStore.appendToStreams!(inputs);
    } catch (cause) {
      if ((cause as { code?: string }).code === "concurrency_conflict") throw cause;
      throw new PricingAuthorityMutationPendingError(inputs, { cause });
    }
  }
  const eventStore: EventStore = {
    ...writer.eventStore,
    appendToStreams: append,
    appendToStream: async (input) => (await append([input]))[0]!.storedEvents,
  };
  const standingAuthority: ListingAuthorityStandingAuthorityPort = source;
  return {
    source,
    standingAuthority,
    eventStore,
    observations: createPricingAuthorityObservations(eventStore),
    evaluate,
    readEvaluation,
    resumePending: (error: PricingAuthorityMutationPendingError) => append(error.inputs),
    resume: writer.resume,
    resumeWrite: writer.resumeWrite,
    recover: createListingAuthorityRecovery({
      db: deps.db,
      owner: "pricing",
      sources: [source],
      consumer: ports.consumer,
      resume: writer.resume,
      resumeWrite: writer.resumeWrite,
      now: deps.now,
    }),
  };
}

export type PricingListingAuthority = ReturnType<typeof createPricingListingAuthority>;
