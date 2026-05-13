import { createAggregateRepository } from "@chase-sets/event-core/aggregate-repository";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import {
  createCommandHandler,
  type CommandHandler,
} from "@chase-sets/event-core/command-handler";
import { createProjector, type Projector } from "@chase-sets/event-core/projector";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { DiscoveryRuntimeDeps } from "../../../support/runtime-support";
import {
  decideProductAlert,
  evolveProductAlert,
  initialProductAlertState,
  productAlertStreamId,
  type ProductAlertCommand,
  type ProductAlertEvent,
  type ProductAlertState,
} from "../domain/domain";
import {
  getProductAlert,
  listProductAlerts,
  type ProductAlertPageRow,
} from "../read-model/queries";
import { buildProductAlertPageProjectionHandlers } from "../read-model/projection";
import type { CreateProductAlertRequest } from "./contracts";

export type ProductAlertServices = Readonly<{
  commandHandler: CommandHandler<
    ProductAlertCommand,
    ProductAlertState,
    ProductAlertEvent
  >;
  createProductAlert: (
    input: CreateProductAlertRequest & Readonly<{ accountId: string }>,
    context: EventStoreContext,
  ) => Promise<Readonly<{ alertId: string; version: number }>>;
  pauseProductAlert: (
    input: Readonly<{ accountId: string; alertId: string }>,
    context: EventStoreContext,
  ) => Promise<Readonly<{ alertId: string; version: number }>>;
  resumeProductAlert: (
    input: Readonly<{ accountId: string; alertId: string }>,
    context: EventStoreContext,
  ) => Promise<Readonly<{ alertId: string; version: number }>>;
  deleteProductAlert: (
    input: Readonly<{ accountId: string; alertId: string }>,
    context: EventStoreContext,
  ) => Promise<Readonly<{ alertId: string; version: number }>>;
  listProductAlerts: (
    input: Readonly<{ accountId: string }>,
  ) => Promise<readonly ProductAlertPageRow[]>;
  getProductAlert: (
    input: Readonly<{ accountId: string; alertId: string }>,
  ) => Promise<ProductAlertPageRow | null>;
  projectors: readonly Projector[];
}>;

export function createProductAlertRuntime(
  deps: DiscoveryRuntimeDeps,
): ProductAlertServices {
  const commandHandler = createCommandHandler({
    repository: createAggregateRepository({
      eventStore: deps.eventStore,
      codec: createPassthroughDomainEventCodec<ProductAlertEvent>(),
      initialState: () => initialProductAlertState,
      evolve: evolveProductAlert,
    }),
    evolve: evolveProductAlert,
    decide: decideProductAlert,
  });

  async function ensureOwnedAlert(accountId: string, alertId: string) {
    const alert = await getProductAlert(deps.db, { accountId, alertId });
    if (!alert || alert.status === "deleted") {
      throw new Error("Product Alert was not found.");
    }
    return alert;
  }

  return {
    commandHandler,
    async createProductAlert(input, context) {
      const alertId = createId("pal");
      const result = await commandHandler({
        streamId: productAlertStreamId(alertId),
        expectedVersion: "no_stream",
        context,
        command: {
          type: "CreateProductAlert",
          alertId,
          accountId: input.accountId,
          marketSide: input.marketSide,
          catalogItemId: input.catalogItemId,
          productId: input.productId,
          selectedOptions: input.selectedOptions ?? [],
          productSummary: input.productSummary ?? null,
          thresholdAmount: input.thresholdAmount ?? null,
        },
      });

      return { alertId, version: result.version };
    },
    async pauseProductAlert(input, context) {
      await ensureOwnedAlert(input.accountId, input.alertId);
      const result = await commandHandler({
        streamId: productAlertStreamId(input.alertId),
        context,
        command: { type: "PauseProductAlert" },
      });

      return { alertId: input.alertId, version: result.version };
    },
    async resumeProductAlert(input, context) {
      await ensureOwnedAlert(input.accountId, input.alertId);
      const result = await commandHandler({
        streamId: productAlertStreamId(input.alertId),
        context,
        command: { type: "ResumeProductAlert" },
      });

      return { alertId: input.alertId, version: result.version };
    },
    async deleteProductAlert(input, context) {
      await ensureOwnedAlert(input.accountId, input.alertId);
      const result = await commandHandler({
        streamId: productAlertStreamId(input.alertId),
        context,
        command: { type: "DeleteProductAlert" },
      });

      return { alertId: input.alertId, version: result.version };
    },
    listProductAlerts: (input) => listProductAlerts(deps.db, input),
    getProductAlert: (input) => getProductAlert(deps.db, input),
    projectors: [
      createProjector({
        projectorName: "discovery-product-alert-page-projection",
        eventStore: deps.eventStore,
        checkpointStore: deps.checkpointStore,
        handlers: buildProductAlertPageProjectionHandlers(deps.db),
      }),
    ],
  };
}
