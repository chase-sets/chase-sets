import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import type { CartLineId } from "../../../support/runtime-support/common";
import {
  decideCheckoutCart,
  decideCheckoutCartReadAuthorityFromState,
  evolveCheckoutCart,
  initialCheckoutCartState,
  requireCheckoutCartClaimIdentity,
  type CheckoutCartCommand,
  type CheckoutCartEvent,
  type CheckoutCartState,
} from "../domain/domain";
import { classifyCheckoutCartSourceAuthority, type CheckoutCartSourceAuthority } from "./contracts";
import {
  createCartReadinessSnapshot,
  type CartReadinessDecisionInput,
  type CartReadinessSnapshot,
} from "../domain/readiness";
import { buildCheckoutCartProjectionHandlers } from "../read-model/projection";
import {
  listAuthorizedOwnerCartLines,
  listCartLines,
  listClaimedCartOwnerKeys,
  ownerKeyCanHoldClaims,
  reconcileCheckoutCartClaim,
  type CheckoutCartLineRow,
} from "../read-model/queries";
import {
  createCheckoutCartAttemptExecutor,
  type CheckoutCartAttemptExecutor,
} from "../../command-attempts/api/cart-attempt";

/**
 * Aggregate reads for claimed-source candidates run a few at a time so that an
 * uncapped claim set cannot turn one Cart read into one simultaneous
 * event-store round trip per claimed source.
 */
export const CHECKOUT_CART_SOURCE_AUTHORITY_WORKERS = 4;

/**
 * Maps every input with at most `limit` calls in flight, in input order.
 *
 * The pool is deliberately explicit rather than a `Promise.all` over the whole
 * set: the caller's input is uncapped, and the result array is filled by index
 * so the bound costs no determinism.
 */
async function mapWithBoundedConcurrency<TInput, TOutput>(
  inputs: readonly TInput[],
  limit: number,
  map: (input: TInput) => Promise<TOutput>,
): Promise<TOutput[]> {
  const results = new Array<TOutput>(inputs.length);
  let nextIndex = 0;
  const runWorker = async () => {
    while (nextIndex < inputs.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await map(inputs[index]!);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, inputs.length) }, runWorker));
  return results;
}

function isIdempotentMergeReplay(error: unknown) {
  return (
    error instanceof Error &&
    (error.message.includes("Cart line has already been added.") ||
      error.message.includes("Cart must contain at least one line."))
  );
}

export type CheckoutCartRuntimeDeps = Readonly<{
  eventStore: EventStore;
  checkpointStore: ProjectionCheckpointStore;
  db: PgQueryable;
}>;

export type CheckoutCartServices = Readonly<{
  commandHandler: CommandHandler<CheckoutCartCommand, CheckoutCartState, CheckoutCartEvent>;
  /**
   * The single cart write entry point: one attempt of 1-250 line commands,
   * decided against the authoritative cart streams and appended atomically with
   * its completed-attempt event. Every cart-write caller supplies an attempt;
   * there is no unkeyed write.
   */
  executeCartAttempt: CheckoutCartAttemptExecutor["executeCartAttempt"];
  /** Reads one attempt by owner, kind, target and id; never writes. */
  lookupCartAttempt: CheckoutCartAttemptExecutor["lookupCartAttempt"];
  claimCart: (
    params: Readonly<{
      sourceOwnerKey: string;
      accountId: AccountId;
    }>,
    context: EventStoreContext,
  ) => Promise<{ version: number }>;
  mergeCartIntoAccount: (
    params: Readonly<{
      sourceOwnerId: string;
      targetAccountId: AccountId;
    }>,
    context: EventStoreContext,
  ) => Promise<{ mergedLineCount: number }>;
  createReadinessSnapshot: (
    params: Readonly<{
      accountId: string;
      presentedAnonymousCartId?: string | null;
      decisions?: CartReadinessDecisionInput | null;
    }>,
  ) => Promise<CartReadinessSnapshot>;
  listCartLines: (accountId: string, presentedAnonymousCartId?: string | null) => ReturnType<typeof listCartLines>;
  /**
   * The single post-claim read decision for one presented anonymous source,
   * taken from complete Cart aggregate state.
   *
   * Callers that need to know *whether* a key may be sourced -- Checkout
   * Session start and every active-session revalidation -- ask here. Callers
   * that only need the lines a reader may see use `listAuthorizedCartLines`,
   * which applies this same decision.
   */
  resolveCartSourceAuthority: (
    params: Readonly<{ actingOwnerKey: string; presentedAnonymousCartId: string }>,
  ) => Promise<CheckoutCartSourceAuthority>;
  /**
   * Cart lines the acting owner may actually read, with every unauthorized
   * source -- presented or alias-derived -- already excluded. Unlike
   * `listCartLines`, which is the raw union used for write routing and internal
   * provenance, this never returns a line sourced from a stream the reader has
   * lost authority over, and never derives a source from the claim alias.
   *
   * The projection read is issued for every syntactically valid key and its rows
   * are discarded afterwards when authority is refused or indeterminate, so a
   * guest refusal costs the same aggregate reads and projection queries a valid
   * unclaimed key does. Nothing about the decision is cached, exposed, or
   * allowed to change a status, body, or header.
   */
  listAuthorizedCartLines: (
    params: Readonly<{ accountId: string; presentedAnonymousCartId?: string | null }>,
  ) => Promise<CheckoutCartLineRow[]>;
  listClaimedOwnerKeys: (accountId: string) => ReturnType<typeof listClaimedCartOwnerKeys>;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createCheckoutCartRuntime(deps: CheckoutCartRuntimeDeps): CheckoutCartServices {
  const { commandHandler, repository } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<CheckoutCartEvent>(),
    initialState: () => initialCheckoutCartState,
    evolve: evolveCheckoutCart,
    decide: decideCheckoutCart,
  });
  const cartProjector = createProjectionHandlerSet({
    projectionName: "checkout.cart-projection",
    inlineApply: true,
    handlers: buildCheckoutCartProjectionHandlers(deps.db),
  });

  /**
   * Resolves the stream that actually holds the line the acting owner can see.
   *
   * The union already decides which single row wins a `line_id` held by more
   * than one owner -- the Account's own row first, then the newest claimed row --
   * so reading `buyer_account_id` off that winning row targets exactly the
   * aggregate the reader was looking at. An id the acting owner cannot see falls
   * back to their own stream, where the aggregate refuses with the unchanged
   * missing-line message rather than reaching for someone else's cart.
   *
   * An owner that cannot hold claims resolves to itself by construction, so the
   * anonymous path keeps its existing single round trip instead of paying for a
   * union read whose answer is already known.
   */
  async function resolveLineSourceOwnerKey(actingOwnerKey: string, lineId: CartLineId) {
    if (!ownerKeyCanHoldClaims(actingOwnerKey)) {
      return actingOwnerKey;
    }

    const visible = await listCartLines(deps.db, actingOwnerKey);
    return visible.find((line) => line.line_id === lineId)?.buyer_account_id ?? actingOwnerKey;
  }

  /**
   * Resolves post-claim read authority from the source stream's own complete
   * event history.
   *
   * The read is deliberately the aggregate and nothing else. `checkout_cart_claims`
   * is never consulted: an event-committed claim whose alias row never landed
   * must still refuse a stranger, and a stale or foreign alias row must not
   * invent access that the events do not support.
   *
   * A failed load is reported as `indeterminate`, never as an unclaimed cart.
   * This catch is the whole point of the variant -- degrading an unreadable
   * stream into "nobody claimed it" is exactly how possession would quietly
   * outlive a claim during a store outage. Indeterminate is not remembered
   * anywhere: the next attempt re-reads authority from scratch.
   */
  const resolveCartSourceAuthority: CheckoutCartServices["resolveCartSourceAuthority"] = async (params) => {
    let state: CheckoutCartState;
    try {
      state = (await repository.load(`checkout.cart-${params.presentedAnonymousCartId}`)).state;
    } catch {
      return { status: "indeterminate" };
    }

    return classifyCheckoutCartSourceAuthority(decideCheckoutCartReadAuthorityFromState(state, params.actingOwnerKey));
  };

  /**
   * Narrows a read to the sources the acting owner still has authority over.
   *
   * Two shapes reach here. A guest reads under the anonymous key itself, so a
   * refused or indeterminate answer leaves no readable source at all and the
   * read resolves to zero lines -- the same answer an unclaimed empty cart
   * gives, which is what keeps guest responses non-enumerating. An Account
   * reads under its own key, carries every source key its claim alias names,
   * and may additionally present an anonymous one.
   *
   * The alias rows are candidate discovery and nothing more. An absent
   * presented key is not an absence of sources to authorize: every candidate is
   * decided against its own Cart aggregate here, and only a candidate accepted
   * *via Account* becomes a requested owner. A refused candidate is a stale or
   * foreign alias row that must not widen the read set, and an indeterminate one
   * is excluded for this request only -- retryable, never recorded, and never
   * cookie-clear eligible -- so a store failure can transiently narrow a
   * claimant's union but can never widen one.
   *
   * The presented key is admitted more broadly than a candidate, by possession
   * of an unclaimed cart or by being the claimant, because presenting a key is
   * the one place possession still means something.
   *
   * The acting Account's own key is never a candidate and never gated:
   * `checkout.cart-acc_x` is that Account's own stream by construction.
   *
   * Candidate decisions are issued as one bounded concurrent batch -- at most
   * `CHECKOUT_CART_SOURCE_AUTHORITY_WORKERS` aggregate reads in flight,
   * never one per alias row and never one serial read per alias row -- are
   * taken once per call, and are never memoized across calls or requests.
   */
  async function resolveAuthorizedCartSource(
    accountId: string,
    presentedAnonymousCartId?: string | null,
  ): Promise<{
    readable: boolean;
    presentedAnonymousCartId: string | null;
    authorizedClaimedOwnerKeys: readonly string[];
  }> {
    if (!ownerKeyCanHoldClaims(accountId)) {
      const authority = await resolveCartSourceAuthority({
        actingOwnerKey: accountId,
        presentedAnonymousCartId: accountId,
      });
      return {
        readable: authority.status === "accepted",
        presentedAnonymousCartId: null,
        authorizedClaimedOwnerKeys: [],
      };
    }

    const presented = presentedAnonymousCartId ?? null;
    const candidateOwnerKeys = await listClaimedCartOwnerKeys(deps.db, accountId);
    // A presented key that is also claimed is decided once, not twice: it is the
    // same aggregate either way, and the union collapses it to one requested
    // owner at the stronger claimed precedence.
    const decidedOwnerKeys =
      presented && !candidateOwnerKeys.includes(presented) ? [...candidateOwnerKeys, presented] : candidateOwnerKeys;
    const decisions = new Map(
      await mapWithBoundedConcurrency(
        decidedOwnerKeys,
        CHECKOUT_CART_SOURCE_AUTHORITY_WORKERS,
        async (ownerKey) =>
          [
            ownerKey,
            await resolveCartSourceAuthority({ actingOwnerKey: accountId, presentedAnonymousCartId: ownerKey }),
          ] as const,
      ),
    );

    const presentedDecision = presented ? decisions.get(presented) : undefined;
    return {
      readable: true,
      presentedAnonymousCartId: presentedDecision?.status === "accepted" ? presented : null,
      authorizedClaimedOwnerKeys: candidateOwnerKeys.filter((ownerKey) => {
        const decision = decisions.get(ownerKey);
        return decision?.status === "accepted" && decision.acceptedVia === "account";
      }),
    };
  }

  const attempts = createCheckoutCartAttemptExecutor({
    eventStore: deps.eventStore,
    db: deps.db,
    loadCart: (streamId) => repository.load(streamId),
    resolveLineSourceOwnerKey,
  });
  return {
    commandHandler,
    executeCartAttempt: attempts.executeCartAttempt,
    lookupCartAttempt: attempts.lookupCartAttempt,
    // Caller-inert foundation: nothing in this repository invokes claimCart.
    // Wiring a caller requires the claimed-stream mutation authority,
    // the post-claim read/session authority, and atomic
    // retirement of the public cart merge endpoint. Neither the alias below nor
    // possession of a claimed key grants any authority on its own.
    //
    // Ownership is serialized on the claimed SOURCE stream, never on the
    // claimant's Account stream: only the shared source stream's loaded-version
    // OCC can order two Accounts racing for the same cart. The alias table's
    // primary key stops contradictory rows; it is not the serialization
    // primitive.
    claimCart: async (params, context) => {
      const claim = requireCheckoutCartClaimIdentity(params);
      const result = await commandHandler({
        streamId: `checkout.cart-${claim.sourceOwnerKey}`,
        command: {
          type: "ClaimCart",
          sourceOwnerKey: claim.sourceOwnerKey,
          accountId: claim.accountId,
        },
        context,
      });

      // Event first, alias second, with no distributed transaction and no
      // projection wait. This runs after a zero-event steady-state return as
      // well, so a retry after a committed event whose alias never landed
      // repairs the pair without appending a second event -- and an alias
      // failure propagates instead of being reported as a successful claim.
      await reconcileCheckoutCartClaim(deps.db, claim);

      return { version: result.version };
    },
    mergeCartIntoAccount: async (params, context) => {
      const sourceLines = await listCartLines(deps.db, params.sourceOwnerId);
      const existingTargetLineIds = new Set(
        (await listCartLines(deps.db, params.targetAccountId)).map((line) => line.line_id),
      );
      for (const line of sourceLines) {
        if (existingTargetLineIds.has(line.line_id)) {
          continue;
        }

        try {
          await commandHandler({
            streamId: `checkout.cart-${params.targetAccountId}`,
            command: {
              type: "AddCartLine",
              buyerAccountId: params.targetAccountId,
              lineId: line.line_id as CartLineId,
              catalogItemId: line.catalog_catalog_item_id,
              productId: line.product_id,
              itemLanguageCode: line.item_language_code,
              itemTitle: line.item_title,
              itemSubtitle: line.item_subtitle,
              itemImageUrl: line.item_image_url,
              itemImageSrcSet: line.item_image_srcset,
              itemImageLoadingUrl: line.item_image_loading_url,
              itemImageLoadingAlt: line.item_image_loading_alt,
              itemImageLoadingSrcSet: line.item_image_loading_srcset,
              selectedOptions: line.selected_options,
              productSummary: line.product_summary,
              quantity: line.quantity,
              fulfillmentMode: line.fulfillment_mode,
              lockedListingId: line.locked_listing_id,
              sellerPreferenceId: line.seller_preference_id,
              selectedListingSnapshot: line.selected_listing_id
                ? {
                    listingId: line.selected_listing_id,
                    sellerAccountId: line.selected_listing_seller_account_id,
                    sellerDisplayName: line.selected_listing_seller_display_name,
                    sellerSlug: line.selected_listing_seller_slug,
                    priceAmount: line.selected_listing_price_amount,
                    priceCurrencyCode: line.selected_listing_price_currency_code,
                    listingStreamVersion: line.selected_listing_stream_version,
                    source: line.selected_listing_snapshot_source,
                  }
                : null,
              availabilityState: line.availability_state,
            },
            context,
          });
        } catch (error) {
          if (!isIdempotentMergeReplay(error)) {
            throw error;
          }
        }
      }

      if (sourceLines.length > 0) {
        try {
          await commandHandler({
            streamId: `checkout.cart-${params.sourceOwnerId}`,
            command: {
              type: "CheckoutCart",
              checkedOutAt: new Date().toISOString(),
            },
            context,
          });
        } catch (error) {
          if (!isIdempotentMergeReplay(error)) {
            throw error;
          }
        }
      }

      return { mergedLineCount: sourceLines.length };
    },
    // Readiness resolves its own source authority rather than trusting the
    // caller's key, so a guest whose cart was claimed and an Account presenting
    // a foreign key both get a snapshot built from sources they may actually
    // read. A refused guest key yields the zero-line snapshot an unclaimed
    // empty cart produces, and reaches it after the same projection read, so
    // the refusal is non-enumerating in the work performed as well as in the
    // bytes returned.
    createReadinessSnapshot: async (params) => {
      const source = await resolveAuthorizedCartSource(params.accountId, params.presentedAnonymousCartId);
      const projected = await listAuthorizedOwnerCartLines(
        deps.db,
        params.accountId,
        source.authorizedClaimedOwnerKeys,
        source.presentedAnonymousCartId,
      );
      const lines = source.readable ? projected : [];
      return createCartReadinessSnapshot(
        lines,
        params.decisions,
        source.presentedAnonymousCartId
          ? {
              accountId: params.accountId,
              presentedAnonymousCartId: source.presentedAnonymousCartId,
            }
          : undefined,
      );
    },
    listCartLines: (accountId, presentedAnonymousCartId) => listCartLines(deps.db, accountId, presentedAnonymousCartId),
    resolveCartSourceAuthority,
    listAuthorizedCartLines: async (params) => {
      const source = await resolveAuthorizedCartSource(params.accountId, params.presentedAnonymousCartId);
      const projected = await listAuthorizedOwnerCartLines(
        deps.db,
        params.accountId,
        source.authorizedClaimedOwnerKeys,
        source.presentedAnonymousCartId,
      );
      return source.readable ? projected : [];
    },
    listClaimedOwnerKeys: (accountId) => listClaimedCartOwnerKeys(deps.db, accountId),
    projectors: [cartProjector],
  };
}
