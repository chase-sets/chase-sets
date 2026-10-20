import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { CheckoutDomainError, type CartLineId } from "../support/runtime-support/common";
import type { CheckoutCartServices } from "../features/cart/api/runtime";
import type {
  CheckoutCartAddCommandInput,
  CheckoutCartLineCommandInput,
} from "../features/command-attempts/api/cart-attempt";
import {
  CHECKOUT_CART_ATTEMPT_CART_TARGET,
  computeCheckoutCommandAttemptRequestHash,
  mintCheckoutCommandAttemptId,
  type CheckoutCartAttemptKind,
  type CheckoutCartLineOutcome,
} from "../features/command-attempts/api/contracts";

type AddLineParams = Omit<CheckoutCartAddCommandInput, "type"> & Readonly<{ accountId: string }>;
type FulfillmentParams = Omit<Extract<CheckoutCartLineCommandInput, { type: "fulfillment" }>, "type"> &
  Readonly<{ accountId: string }>;

/**
 * Test-only driver: the per-command shapes the cart runtime used to expose,
 * each issued as one fresh Cart attempt through `executeCartAttempt`. A refused
 * line rethrows its domain message, so behaviour tests keep their assertions
 * while every write still goes through the attempt path.
 */
export function cartAttemptDriver(services: Pick<CheckoutCartServices, "executeCartAttempt">) {
  async function run(
    ownerKey: string,
    kind: CheckoutCartAttemptKind,
    target: string,
    commands: readonly CheckoutCartLineCommandInput[],
    context: EventStoreContext,
  ) {
    const { result } = await services.executeCartAttempt(
      {
        ownerKey,
        attemptId: mintCheckoutCommandAttemptId(),
        kind,
        target,
        requestHash: await computeCheckoutCommandAttemptRequestHash({ commands }),
        commands,
      },
      context,
    );
    if (result.ownerStatus !== "committed") {
      throw new CheckoutDomainError(`Cart attempt was ${result.ownerStatus}.`);
    }
    return result.vector!;
  }

  function succeeded(line: CheckoutCartLineOutcome) {
    if (line.outcome !== "succeeded") {
      throw new CheckoutDomainError(line.message ?? "Cart command was refused.");
    }
    return line;
  }

  return {
    addLine: async ({ accountId, ...line }: AddLineParams, context: EventStoreContext) => {
      const [entry] = await run(
        accountId,
        "cart.add-line",
        CHECKOUT_CART_ATTEMPT_CART_TARGET,
        [{ type: "add", ...line }],
        context,
      );
      const added = succeeded(entry!);
      return { lineId: added.lineId as CartLineId, version: added.version, status: added.status as "added" | "merged" };
    },
    addLines: async (
      params: Readonly<{ accountId: string; lines: readonly Omit<CheckoutCartAddCommandInput, "type">[] }>,
      context: EventStoreContext,
    ) => {
      const vector = await run(
        params.accountId,
        "cart.add-lines",
        CHECKOUT_CART_ATTEMPT_CART_TARGET,
        params.lines.map((line) => ({ type: "add" as const, ...line })),
        context,
      );
      const lines = vector.map((line) => ({
        index: line.index,
        lineId: line.outcome === "succeeded" ? (line.lineId as CartLineId) : null,
        status: line.outcome === "succeeded" ? (line.status as "added" | "merged") : ("failed" as const),
        message: line.outcome === "succeeded" ? null : line.message,
      }));
      return {
        requestedLineCount: lines.length,
        addedLineCount: lines.filter((line) => line.status === "added").length,
        mergedLineCount: lines.filter((line) => line.status === "merged").length,
        failedLineCount: lines.filter((line) => line.status === "failed").length,
        lines,
      };
    },
    setLineQuantity: async (
      params: Readonly<{ accountId: string; lineId: CartLineId; quantity: number }>,
      context: EventStoreContext,
    ) => {
      const [entry] = await run(
        params.accountId,
        "cart.set-quantity",
        params.lineId,
        [{ type: "quantity", lineId: params.lineId, quantity: params.quantity }],
        context,
      );
      return { lineId: params.lineId, version: succeeded(entry!).version };
    },
    setLineFulfillment: async ({ accountId, ...command }: FulfillmentParams, context: EventStoreContext) => {
      const [entry] = await run(
        accountId,
        "cart.set-fulfillment",
        command.lineId,
        [{ type: "fulfillment", ...command }],
        context,
      );
      return { lineId: command.lineId, version: succeeded(entry!).version };
    },
    removeLine: async (params: Readonly<{ accountId: string; lineId: CartLineId }>, context: EventStoreContext) => {
      const [entry] = await run(
        params.accountId,
        "cart.remove-line",
        params.lineId,
        [{ type: "remove", lineId: params.lineId }],
        context,
      );
      return { lineId: params.lineId, version: succeeded(entry!).version };
    },
  };
}
