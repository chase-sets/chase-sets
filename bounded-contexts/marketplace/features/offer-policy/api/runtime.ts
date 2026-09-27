import { createHash } from "node:crypto";
import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { AppendToStreamInput, EventStoreContext } from "@chase-sets/event-core/storage";
import { createProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { centsToMoneyAmount, moneyToCents } from "@chase-sets/primitives/money";
import {
  decideMarketplaceOffer,
  evolveMarketplaceOffer,
  initialMarketplaceOfferState,
  type MarketplaceOfferEvent,
} from "../../offers/domain/domain";
import { buyerOfferPolicyCodec } from "../domain/codec";
import {
  buyerOfferPolicyIdSchema,
  buyerOfferPolicyRequestSchema,
  type BuyerOfferPolicyRequest,
} from "../domain/contracts";
import {
  assertPolicy,
  assertBuyerOfferPolicySelection,
  BuyerOfferPolicyError,
  decideBuyerOfferPolicy,
  evolveBuyerOfferPolicy,
  initialBuyerOfferPolicyState,
  validateBuyerOfferPolicyTerms,
  type BuyerOfferPolicyAudit,
  type BuyerOfferPolicyCommand,
  type BuyerOfferPolicyState,
} from "../domain/domain";
import { buildBuyerOfferPolicyProjectionHandlers } from "../read-model/projection";

function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
const streamId = (policyId: string) => `marketplace.offer-policy-${policyId}`;

export function serializeBuyerOfferPolicy(state: BuyerOfferPolicyState, version: number) {
  return {
    policyId: state.policyId,
    status: state.status,
    version,
    revision: state.revision,
    currency: state.currency ?? state.preview?.terms.currency ?? null,
    consumedItemAmount: state.consumedItemAmount,
    remainingItemAllowance: state.authority
      ? centsToMoneyAmount(
          moneyToCents(state.authority.itemCommitmentAllowance) - moneyToCents(state.consumedItemAmount),
        )
      : null,
    authority: state.authority,
    preview: state.preview,
  };
}

export function createBuyerOfferPolicyRuntime(
  deps: Readonly<{
    eventStore: EventStore;
    db: PgQueryable;
    /** Installed only alongside atomic application/acceptance enforcement, never an account-controlled flag. */
    enforcement?: Readonly<{ assertInstalled(): void }>;
  }>,
) {
  const { repository } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: buyerOfferPolicyCodec,
    initialState: () => initialBuyerOfferPolicyState,
    evolve: evolveBuyerOfferPolicy,
    decide: decideBuyerOfferPolicy,
  });
  const offerCodec = createPassthroughDomainEventCodec<MarketplaceOfferEvent>();
  const { repository: offers } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: offerCodec,
    initialState: () => initialMarketplaceOfferState,
    evolve: evolveMarketplaceOffer,
    decide: decideMarketplaceOffer,
  });

  async function owned(policyId: string, buyerAccountId: string) {
    buyerOfferPolicyIdSchema.parse(policyId);
    const loaded = await repository.load(streamId(policyId));
    if (loaded.state.buyerAccountId !== buyerAccountId)
      throw new BuyerOfferPolicyError("not_found", "Buyer Offer Policy not found.");
    return loaded;
  }

  async function execute(policyId: string, input: BuyerOfferPolicyRequest, context: EventStoreContext) {
    buyerOfferPolicyIdSchema.parse(policyId);
    const request = buyerOfferPolicyRequestSchema.parse(input);
    const buyerAccountId = context.audit.forAccountId;
    const current =
      request.type === "CreateBuyerOfferPolicy"
        ? await repository.load(streamId(policyId))
        : await owned(policyId, buyerAccountId);
    if (current.state.policyId && current.state.buyerAccountId !== buyerAccountId)
      throw new BuyerOfferPolicyError("not_found", "Buyer Offer Policy not found.");
    const requestHash = hash({ policyId, actorUserId: context.audit.performedByUserId, buyerAccountId, request });
    const prior = current.events.find((event) => event.data.operationId === request.operationId);
    if (prior) {
      if (prior.data.requestHash !== requestHash)
        throw new BuyerOfferPolicyError(
          "operation_conflict",
          "Operation identity was already used for different authority.",
        );
      return serializeBuyerOfferPolicy(current.state, current.version);
    }
    if (request.expectedVersion !== current.version)
      throw new BuyerOfferPolicyError("stale_preview", "Policy version changed. Refresh before continuing.");
    const audit: BuyerOfferPolicyAudit = {
      schemaVersion: 1,
      policyId,
      buyerAccountId,
      actorUserId: context.audit.performedByUserId,
      operationId: request.operationId,
      requestHash,
      recordedAt: new Date().toISOString(),
    };
    let command: BuyerOfferPolicyCommand;
    const guards: AppendToStreamInput[] = [];
    if (request.type === "PreviewBuyerOfferPolicy" || request.type === "AuthorizeBuyerOfferPolicy") {
      const previewTerms = request.type === "PreviewBuyerOfferPolicy" ? request.terms : current.state.preview?.terms;
      if (!previewTerms) throw new BuyerOfferPolicyError("stale_preview", "A fresh preview is required.");
      const terms = validateBuyerOfferPolicyTerms(current.state, previewTerms);
      const loadedOffers = await Promise.all(
        terms.offers.map((selection) => offers.load(`marketplace.offer-${selection.offerId}`)),
      );
      assertBuyerOfferPolicySelection(policyId, buyerAccountId, terms, loadedOffers);
      for (const [index, loaded] of loadedOffers.entries()) {
        guards.push({
          streamId: `marketplace.offer-${terms.offers[index]!.offerId}`,
          expectedVersion: loaded.version,
          context,
          events:
            request.type === "AuthorizeBuyerOfferPolicy"
              ? decideMarketplaceOffer(loaded.state, { type: "BindOfferToBuyerPolicy", buyerAccountId, policyId }).map(
                  offerCodec.encode,
                )
              : [],
        });
      }
      if (request.type === "PreviewBuyerOfferPolicy") {
        command = {
          type: request.type,
          audit,
          preview: {
            previewId: hash({ policyId, policyVersion: current.version + 1, terms }),
            policyVersion: current.version + 1,
            terms,
          },
        };
      } else {
        if (!deps.enforcement)
          throw new BuyerOfferPolicyError(
            "enforcement_unavailable",
            "Managed Offer acceptance and application enforcement is not installed.",
          );
        deps.enforcement.assertInstalled();
        command = {
          type: request.type,
          audit,
          previewId: request.previewId,
          policyVersion: current.version,
          consent: request.consent,
        };
      }
    } else command = { type: request.type, audit };
    const events = decideBuyerOfferPolicy(current.state, command);
    if (events.length === 0) return serializeBuyerOfferPolicy(current.state, current.version);
    assertPolicy(deps.eventStore.appendToStreams, "Buyer Offer Policy commands require atomic append support.");
    try {
      await deps.eventStore.appendToStreams([
        {
          streamId: streamId(policyId),
          expectedVersion: current.version,
          events: events.map(buyerOfferPolicyCodec.encode),
          context,
        },
        ...guards,
      ]);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "concurrency_conflict") {
        const latest = await owned(policyId, buyerAccountId);
        if (
          latest.events.some(
            (event) => event.data.operationId === request.operationId && event.data.requestHash === requestHash,
          )
        )
          return serializeBuyerOfferPolicy(latest.state, latest.version);
        throw new BuyerOfferPolicyError("stale_preview", "Policy or selected Offers changed. Request a fresh preview.");
      }
      throw error;
    }
    return serializeBuyerOfferPolicy(
      events.reduce(evolveBuyerOfferPolicy, current.state),
      current.version + events.length,
    );
  }
  return {
    execute,
    async get(policyId: string, buyerAccountId: string) {
      const current = await owned(policyId, buyerAccountId);
      return serializeBuyerOfferPolicy(current.state, current.version);
    },
    async list(buyerAccountId: string, afterPolicyId = "", limit = 100) {
      assertPolicy(
        Number.isInteger(limit) && limit >= 1 && limit <= 100,
        "Policy page size must be between 1 and 100.",
      );
      if (afterPolicyId) buyerOfferPolicyIdSchema.parse(afterPolicyId);
      const result = await deps.db.query<{ state: BuyerOfferPolicyState; last_stream_version: number }>(
        `SELECT state, last_stream_version FROM marketplace_buyer_offer_policy_pages
         WHERE buyer_account_id = $1 AND policy_id > $2 ORDER BY policy_id LIMIT $3`,
        [buyerAccountId, afterPolicyId, limit],
      );
      return {
        items: result.rows.map((row) => serializeBuyerOfferPolicy(row.state, row.last_stream_version)),
        nextCursor: result.rows.length === limit ? result.rows.at(-1)!.state.policyId : null,
      };
    },
    projectors: [
      createProjectionHandlerSet({
        projectionName: "marketplace-offer-policy-projection",
        handlers: buildBuyerOfferPolicyProjectionHandlers(deps.db),
      }),
    ],
  };
}
export type BuyerOfferPolicyServices = ReturnType<typeof createBuyerOfferPolicyRuntime>;
