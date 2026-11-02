import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { recordCommittedEvents } from "@chase-sets/event-core/consistency";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { AppendToStreamInput, EventStoreContext, StoredEvent } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import {
  CheckoutDomainError,
  createCheckoutProductDescriptor,
  type CartLineId,
  type CheckoutVersionSchema,
} from "../../../support/runtime-support/common";
import {
  decideCheckoutCart,
  evolveCheckoutCart,
  type CheckoutCartCommand,
  type CheckoutCartEvent,
  type CheckoutCartState,
  type CheckoutSelectedListingSnapshotInput,
} from "../../cart/domain/domain";
import { listClaimedCartOwnerKeys } from "../../cart/read-model/queries";
import {
  checkoutCommandAttemptActorBinding,
  checkoutCommandAttemptCompletedEvent,
  checkoutCommandAttemptFingerprint,
  checkoutCommandAttemptStreamId,
  readCheckoutCommandAttemptHistory,
  withCheckoutCommandAttemptReceipt,
  type CheckoutCommandAttemptHistory,
} from "./attempt-history";
import {
  CHECKOUT_CART_ATTEMPT_MAX_COMMANDS,
  isCheckoutCartAttemptKind,
  isCheckoutCommandAttemptId,
  type CheckoutCartAttemptKind,
  type CheckoutCartLineCommandName,
  type CheckoutCartLineOutcome,
  type CheckoutCommandAttemptResult,
} from "./contracts";

export type CheckoutCartAddCommandInput = Readonly<{
  type: "add";
  catalogItemId: string;
  productId: string;
  itemTitle: string;
  itemSubtitle: string | null;
  itemImageUrl: string | null;
  itemImageSrcSet?: string | null;
  itemImageLoadingUrl?: string | null;
  itemImageLoadingAlt?: string | null;
  itemImageLoadingSrcSet?: string | null;
  selectedOptions: readonly { dimensionId: string; optionId: string }[];
  productSummary: string | null;
  quantity: number;
  fulfillmentMode?: "optimize" | "locked-listing";
  lockedListingId?: string | null;
  sellerPreferenceId?: string | null;
  selectedListingSnapshot?: CheckoutSelectedListingSnapshotInput | null;
}>;

export type CheckoutCartLineCommandInput =
  | CheckoutCartAddCommandInput
  | Readonly<{ type: "quantity"; lineId: CartLineId; quantity: number }>
  | Readonly<{
      type: "fulfillment";
      lineId: CartLineId;
      fulfillmentMode: "optimize" | "locked-listing";
      lockedListingId?: string | null;
      sellerPreferenceId?: string | null;
      selectedListingSnapshot?: CheckoutSelectedListingSnapshotInput | null;
      availabilityState?: "available" | "unavailable" | "changed" | "waiting-for-supply";
    }>
  | Readonly<{ type: "remove"; lineId: CartLineId }>
  | Readonly<{ type: "checkout" }>;

export type CheckoutCartAttemptRequest = Readonly<{
  /** The acting cart owner: an Account id or an anonymous cart key. */
  ownerKey: string;
  attemptId: string;
  kind: CheckoutCartAttemptKind;
  target: string;
  requestHash: string;
  commands: readonly CheckoutCartLineCommandInput[];
  /** Guest carts may hold at most this many lines; a command that would exceed it refuses the attempt. */
  newLineLimit?: number;
}>;

export type CheckoutCartAttemptOutcome = Readonly<{
  result: CheckoutCommandAttemptResult;
  replayed: boolean;
}>;

/**
 * A refusal decided before any append and never recorded: malformed attempt
 * identity, an out-of-bound batch, or a guest line limit. Each is deterministic
 * for the same request, so an exact retry is refused the same way.
 */
export class CheckoutCommandAttemptRefusal extends CheckoutDomainError {
  public constructor(
    message: string,
    code: "checkout_attempt_required" | "cart_attempt_too_large" | "anonymous_cart_limit_exceeded",
  ) {
    super(message, code);
    this.name = "CheckoutCommandAttemptRefusal";
  }
}

/** A cart-stream version conflict re-decides at most this many times before the attempt is failed-safe. */
export const CHECKOUT_CART_ATTEMPT_MAX_REDECISIONS = 2;

const CART_OWNERSHIP_REFUSAL = "Cart is owned by a different account.";
const LINE_CONFLICT_MESSAGES = new Set(["Cart line not found.", "Cart line has already been added."]);

export type CheckoutCartAttemptDeps = Readonly<{
  eventStore: EventStore;
  db: PgQueryable;
  loadCart: (streamId: string) => Promise<Readonly<{ state: CheckoutCartState; version: number }>>;
  /** Routing index only: which stream holds the line the owner sees. The decision reads that stream's own state. */
  resolveLineSourceOwnerKey: (ownerKey: string, lineId: CartLineId) => Promise<string>;
  now?: () => Date;
}>;

type LoadedCartStream = {
  ownerKey: string;
  state: CheckoutCartState;
  loadedVersion: number;
  events: CheckoutCartEvent[];
};

const codec = createPassthroughDomainEventCodec<CheckoutCartEvent>();

function cartStreamId(ownerKey: string) {
  return `checkout.cart-${ownerKey}`;
}

function isEventStoreConflict(error: unknown) {
  return (error as { code?: unknown } | null)?.code === "concurrency_conflict";
}

function assertAttemptRequest(request: CheckoutCartAttemptRequest) {
  if (
    !isCheckoutCommandAttemptId(request.attemptId) ||
    !isCheckoutCartAttemptKind(request.kind) ||
    typeof request.target !== "string" ||
    request.target.length === 0 ||
    request.target.length > 128 ||
    !/^[0-9a-f]{64}$/.test(request.requestHash) ||
    !request.ownerKey
  ) {
    throw new CheckoutCommandAttemptRefusal("A caller-created cart attempt is required.", "checkout_attempt_required");
  }
  if (request.commands.length === 0 || request.commands.length > CHECKOUT_CART_ATTEMPT_MAX_COMMANDS) {
    throw new CheckoutCommandAttemptRefusal(
      `A cart write carries 1 to ${CHECKOUT_CART_ATTEMPT_MAX_COMMANDS} line commands.`,
      "cart_attempt_too_large",
    );
  }
}

export function createCheckoutCartAttemptExecutor(deps: CheckoutCartAttemptDeps) {
  const now = deps.now ?? (() => new Date());

  async function getCatalogItemSnapshot(catalogItemId: string) {
    const result = await deps.db.query<{
      catalog_item_id: string;
      language_code: string;
      status: string;
      product_schema: unknown;
    }>(
      `SELECT catalog_item_id, language_code, status, product_schema
       FROM checkout_catalog_items
       WHERE catalog_item_id = $1`,
      [catalogItemId],
    );

    return result.rows[0] ?? null;
  }

  /**
   * Decides every line command against one evolving in-memory cart state per
   * stream. Nothing is appended here: a command that refuses leaves no event,
   * and the next command sees the state the earlier commands produced.
   */
  async function decideBatch(request: CheckoutCartAttemptRequest) {
    const streams = new Map<string, LoadedCartStream>();
    const load = async (ownerKey: string) => {
      const existing = streams.get(ownerKey);
      if (existing) return existing;
      const loaded = await deps.loadCart(cartStreamId(ownerKey));
      const stream: LoadedCartStream = { ownerKey, state: loaded.state, loadedVersion: loaded.version, events: [] };
      streams.set(ownerKey, stream);
      return stream;
    };
    // Each line command is all or nothing across the streams it touches: the
    // first change a command makes to a stream saves that stream's state, and
    // a command that then refuses restores every stream it changed.
    let commandCheckpoints = new Map<LoadedCartStream, { state: CheckoutCartState; eventCount: number }>();
    const apply = (stream: LoadedCartStream, command: CheckoutCartCommand) => {
      if (!commandCheckpoints.has(stream)) {
        commandCheckpoints.set(stream, { state: stream.state, eventCount: stream.events.length });
      }
      const events = decideCheckoutCart(stream.state, command) as CheckoutCartEvent[];
      for (const event of events) {
        stream.state = evolveCheckoutCart(stream.state, event);
        stream.events.push(event);
      }
      return events.length;
    };
    const own = await load(request.ownerKey);
    let claimedOwnerKeys: readonly string[] | null = null;
    const outcomes: Array<Omit<CheckoutCartLineOutcome, "version"> & { streams: LoadedCartStream[] }> = [];

    for (const [index, command] of request.commands.entries()) {
      const name: CheckoutCartLineCommandName = command.type;
      commandCheckpoints = new Map();
      try {
        switch (command.type) {
          case "add": {
            const catalogItem = await getCatalogItemSnapshot(command.catalogItemId);
            if (!catalogItem) throw new CheckoutDomainError("Catalog item not found.");
            if (catalogItem.status !== "active") {
              throw new CheckoutDomainError("Cart lines may only reference active catalog items.");
            }
            const catalogVersion = createCheckoutProductDescriptor({
              catalogItemId: command.catalogItemId,
              productSchema:
                typeof catalogItem.product_schema === "object" && catalogItem.product_schema !== null
                  ? (catalogItem.product_schema as CheckoutVersionSchema)
                  : null,
              selection: command.selectedOptions,
            });
            if (command.productId.trim() !== catalogVersion.productId) {
              throw new CheckoutDomainError("Cart line product id does not match the selected options.");
            }
            const lockedListingId = command.lockedListingId?.trim() || null;
            const fulfillmentMode =
              command.fulfillmentMode === "locked-listing" || lockedListingId ? "locked-listing" : "optimize";
            const sellerPreferenceId = command.sellerPreferenceId?.trim() || null;
            // Own stream only, read from its evolved state: a matching line on a
            // claimed source stream must not turn this add into a quantity write
            // against the Account stream, and a lagging projection must not make
            // a retried add re-merge.
            const existingLine = own.state.lines.find(
              (line) =>
                line.catalogItemId === command.catalogItemId &&
                line.productId === catalogVersion.productId &&
                line.fulfillmentMode === fulfillmentMode &&
                (line.lockedListingId ?? null) === lockedListingId &&
                (line.sellerPreferenceId ?? null) === sellerPreferenceId,
            );
            if (existingLine) {
              apply(own, {
                type: "SetCartLineQuantity",
                actingOwnerKey: request.ownerKey,
                lineId: existingLine.lineId,
                quantity: existingLine.quantity + command.quantity,
              });
              outcomes.push({
                index,
                command: name,
                outcome: "succeeded",
                lineId: existingLine.lineId,
                status: "merged",
                message: null,
                streams: [own],
              });
              break;
            }
            if (request.newLineLimit !== undefined && own.state.lines.length >= request.newLineLimit) {
              throw new CheckoutCommandAttemptRefusal(
                `Anonymous carts may hold at most ${request.newLineLimit} lines.`,
                "anonymous_cart_limit_exceeded",
              );
            }
            const lineId = createId("cli") as CartLineId;
            apply(own, {
              type: "AddCartLine",
              buyerAccountId: request.ownerKey as AccountId,
              lineId,
              catalogItemId: command.catalogItemId,
              productId: catalogVersion.productId,
              itemLanguageCode: catalogItem.language_code,
              itemTitle: command.itemTitle,
              itemSubtitle: command.itemSubtitle,
              itemImageUrl: command.itemImageUrl,
              itemImageSrcSet: command.itemImageSrcSet,
              itemImageLoadingUrl: command.itemImageLoadingUrl,
              itemImageLoadingAlt: command.itemImageLoadingAlt,
              itemImageLoadingSrcSet: command.itemImageLoadingSrcSet,
              selectedOptions: catalogVersion.selection,
              productSummary: command.productSummary,
              quantity: command.quantity,
              fulfillmentMode,
              lockedListingId,
              sellerPreferenceId,
              selectedListingSnapshot: command.selectedListingSnapshot,
              availabilityState: "available",
            });
            outcomes.push({
              index,
              command: name,
              outcome: "succeeded",
              lineId,
              status: "added",
              message: null,
              streams: [own],
            });
            break;
          }
          case "quantity":
          case "fulfillment": {
            const stream = await load(await deps.resolveLineSourceOwnerKey(request.ownerKey, command.lineId));
            apply(
              stream,
              command.type === "quantity"
                ? {
                    type: "SetCartLineQuantity",
                    actingOwnerKey: request.ownerKey,
                    lineId: command.lineId,
                    quantity: command.quantity,
                  }
                : {
                    type: "SetCartLineFulfillment",
                    actingOwnerKey: request.ownerKey,
                    lineId: command.lineId,
                    fulfillmentMode: command.fulfillmentMode,
                    lockedListingId: command.lockedListingId,
                    sellerPreferenceId: command.sellerPreferenceId,
                    selectedListingSnapshot: command.selectedListingSnapshot,
                    availabilityState: command.availabilityState,
                  },
            );
            outcomes.push({
              index,
              command: name,
              outcome: "succeeded",
              lineId: command.lineId,
              status: command.type === "quantity" ? "quantity-updated" : "fulfillment-updated",
              message: null,
              streams: [stream],
            });
            break;
          }
          case "remove": {
            // Line-id-total across the owner's own stream and every stream it has
            // claimed. Only the missing-line refusal is absorbed, per owner; an
            // ownership refusal from a stale alias propagates. A line no owner
            // holds is a no-op that still succeeds.
            claimedOwnerKeys ??= await listClaimedCartOwnerKeys(deps.db, request.ownerKey);
            const touched: LoadedCartStream[] = [];
            for (const ownerKey of [request.ownerKey, ...claimedOwnerKeys]) {
              const stream = await load(ownerKey);
              try {
                apply(stream, { type: "RemoveCartLine", actingOwnerKey: request.ownerKey, lineId: command.lineId });
                touched.push(stream);
              } catch (error) {
                if (!(error instanceof CheckoutDomainError && error.message === "Cart line not found.")) throw error;
              }
            }
            outcomes.push({
              index,
              command: name,
              outcome: "succeeded",
              lineId: command.lineId,
              status: "removed",
              message: null,
              streams: touched,
            });
            break;
          }
          case "checkout": {
            apply(own, { type: "CheckoutCart", checkedOutAt: now().toISOString() });
            outcomes.push({
              index,
              command: name,
              outcome: "succeeded",
              lineId: null,
              status: "checked-out",
              message: null,
              streams: [own],
            });
            break;
          }
        }
      } catch (error) {
        if (
          error instanceof CheckoutCommandAttemptRefusal ||
          !(error instanceof CheckoutDomainError) ||
          error.message === CART_OWNERSHIP_REFUSAL
        ) {
          throw error;
        }
        for (const [stream, checkpoint] of commandCheckpoints) {
          stream.state = checkpoint.state;
          stream.events.length = checkpoint.eventCount;
        }
        outcomes.push({
          index,
          command: name,
          outcome: LINE_CONFLICT_MESSAGES.has(error.message) ? "conflict" : "error",
          lineId: "lineId" in command ? command.lineId : null,
          status: null,
          message: error.message.slice(0, 512),
          streams: [],
        });
      }
    }

    const finalVersion = (stream: LoadedCartStream) => stream.loadedVersion + stream.events.length;
    const vector: CheckoutCartLineOutcome[] = outcomes.map(({ streams: touched, ...outcome }) => ({
      ...outcome,
      version: touched[0] ? finalVersion(touched[0]) : 0,
    }));
    return { streams: [...streams.values()], vector };
  }

  function baseResult(request: CheckoutCartAttemptRequest, fingerprint: string) {
    return {
      schemaVersion: 1 as const,
      kind: request.kind,
      fingerprint,
      actorBinding: checkoutCommandAttemptActorBinding(request.ownerKey),
      target: request.target,
      requestHash: request.requestHash,
    };
  }

  function resolveRecorded(
    request: CheckoutCartAttemptRequest,
    fingerprint: string,
    history: Exclude<CheckoutCommandAttemptHistory, { kind: "absent" }>,
  ): CheckoutCartAttemptOutcome {
    if (history.kind === "history-incomplete") {
      return {
        result: { ...baseResult(request, fingerprint), ownerStatus: "ambiguous", reason: "history-incomplete" },
        replayed: true,
      };
    }
    const recorded = history.result;
    const binding = checkoutCommandAttemptActorBinding(request.ownerKey);
    if (
      recorded.kind !== request.kind ||
      recorded.target !== request.target ||
      recorded.actorBinding.kind !== binding.kind ||
      recorded.actorBinding.digest !== binding.digest
    ) {
      return {
        result: { ...baseResult(request, fingerprint), ownerStatus: "ambiguous", reason: "history-incomplete" },
        replayed: true,
      };
    }
    if (recorded.requestHash !== request.requestHash) {
      return { result: { ...baseResult(request, fingerprint), ownerStatus: "conflict" }, replayed: true };
    }
    return { result: recorded, replayed: true };
  }

  function appendAll(inputs: readonly AppendToStreamInput[]) {
    if (!deps.eventStore.appendToStreams) {
      throw new Error("Checkout cart attempts require an atomic multi-stream event store.");
    }
    return deps.eventStore.appendToStreams(inputs);
  }

  function recordCommitted(results: readonly { storedEvents: readonly StoredEvent[] }[]) {
    recordCommittedEvents(results.flatMap((entry) => entry.storedEvents));
  }

  /**
   * Applies one cart attempt exactly once.
   *
   * An exact replay returns the first result and appends nothing; a changed
   * request under the same attempt is a conflict and appends nothing. A fresh
   * attempt appends its cart events and one completed-attempt event in a single
   * all-or-nothing `appendToStreams` at the cart streams' loaded versions, the
   * attempt stream at `no_stream`. Losing the attempt-stream race reads the
   * winner; losing a cart-stream race re-decides at most twice, then records
   * the attempt as failed-safe with zero cart events.
   */
  async function executeCartAttempt(
    request: CheckoutCartAttemptRequest,
    context: EventStoreContext,
  ): Promise<CheckoutCartAttemptOutcome> {
    assertAttemptRequest(request);
    const fingerprint = checkoutCommandAttemptFingerprint({
      ownerKey: request.ownerKey,
      kind: request.kind,
      target: request.target,
      attemptId: request.attemptId,
    });
    const attemptStreamId = checkoutCommandAttemptStreamId(fingerprint);
    const prior = await readCheckoutCommandAttemptHistory(deps.eventStore, fingerprint);
    if (prior.kind !== "absent") {
      return resolveRecorded(request, fingerprint, prior);
    }

    for (let decision = 0; decision <= CHECKOUT_CART_ATTEMPT_MAX_REDECISIONS; decision += 1) {
      const decided = await decideBatch(request);
      const result: CheckoutCommandAttemptResult = {
        ...baseResult(request, fingerprint),
        ownerStatus: "committed",
        vector: decided.vector,
      };
      const cartInputs: AppendToStreamInput[] = decided.streams
        .filter((stream) => stream.events.length > 0 || stream.loadedVersion > 0)
        .map((stream) => ({
          streamId: cartStreamId(stream.ownerKey),
          expectedVersion: stream.loadedVersion === 0 ? "no_stream" : stream.loadedVersion,
          context,
          events: stream.events.map((event) => codec.encode(event)),
        }));
      try {
        const appended = await appendAll([
          ...cartInputs,
          {
            streamId: attemptStreamId,
            expectedVersion: "no_stream",
            context,
            events: [checkoutCommandAttemptCompletedEvent(result)],
          },
        ]);
        recordCommitted(appended);
        const attemptEvent = appended.find((entry) => entry.streamId === attemptStreamId)?.storedEvents[0];
        return { result: withCheckoutCommandAttemptReceipt(result, attemptEvent), replayed: false };
      } catch (error) {
        if (!isEventStoreConflict(error)) throw error;
        const winner = await readCheckoutCommandAttemptHistory(deps.eventStore, fingerprint);
        if (winner.kind !== "absent") {
          return resolveRecorded(request, fingerprint, winner);
        }
      }
    }

    const failedSafe: CheckoutCommandAttemptResult = {
      ...baseResult(request, fingerprint),
      ownerStatus: "failed-safe",
      reason: "cart-changed",
    };
    try {
      const appended = await appendAll([
        {
          streamId: attemptStreamId,
          expectedVersion: "no_stream",
          context,
          events: [checkoutCommandAttemptCompletedEvent(failedSafe)],
        },
      ]);
      recordCommitted(appended);
      return { result: withCheckoutCommandAttemptReceipt(failedSafe, appended[0]?.storedEvents[0]), replayed: false };
    } catch (error) {
      if (!isEventStoreConflict(error)) throw error;
      const winner = await readCheckoutCommandAttemptHistory(deps.eventStore, fingerprint);
      if (winner.kind === "absent") throw error;
      return resolveRecorded(request, fingerprint, winner);
    }
  }

  /**
   * The owner lookup: reads the attempt stream once and writes nothing.
   * Missing, wrong-owner and unmatched attempts all address a stream that does
   * not exist under the presenter's own binding, so they share one identical
   * `not-observed` answer.
   */
  async function lookupCartAttempt(
    request: Omit<CheckoutCartAttemptRequest, "commands" | "newLineLimit">,
  ): Promise<CheckoutCommandAttemptResult> {
    const fingerprint = checkoutCommandAttemptFingerprint({
      ownerKey: request.ownerKey,
      kind: request.kind,
      target: request.target,
      attemptId: request.attemptId,
    });
    const history = await readCheckoutCommandAttemptHistory(deps.eventStore, fingerprint);
    if (history.kind === "absent") {
      return { ...baseResult({ ...request, commands: [] }, fingerprint), ownerStatus: "not-observed" };
    }
    return resolveRecorded({ ...request, commands: [] }, fingerprint, history).result;
  }

  return { executeCartAttempt, lookupCartAttempt };
}

export type CheckoutCartAttemptExecutor = ReturnType<typeof createCheckoutCartAttemptExecutor>;
