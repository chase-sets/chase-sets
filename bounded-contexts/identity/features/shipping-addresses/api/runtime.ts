import { createAggregateRepository } from "@chase-sets/event-core/aggregate-repository";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { createCommandHandler, type CommandHandler } from "@chase-sets/event-core/command-handler";
import { createProjector, type Projector } from "@chase-sets/event-core/projector";
import type { IdentityRuntimeDeps } from "../../../support/runtime-support";
import {
  decideShippingAddressBook,
  evolveShippingAddressBook,
  initialShippingAddressBookState,
  type ShippingAddressBookState,
  type ShippingAddressCommand,
  type ShippingAddressEvent,
} from "../domain/domain";
import { getShippingAddress, listShippingAddresses } from "../read-model/queries";
import { buildShippingAddressProjectionHandlers } from "../read-model/projection";

export type ShippingAddressServices = Readonly<{
  commandHandler: CommandHandler<ShippingAddressCommand, ShippingAddressBookState, ShippingAddressEvent>;
  listShippingAddresses: (
    accountId: string,
    options?: Parameters<typeof listShippingAddresses>[2],
  ) => ReturnType<typeof listShippingAddresses>;
  getShippingAddress: (accountId: string, shippingAddressId: string) => ReturnType<typeof getShippingAddress>;
  projectors: readonly Projector[];
}>;

export function createShippingAddressRuntime(deps: IdentityRuntimeDeps): ShippingAddressServices {
  const commandHandler = createCommandHandler({
    repository: createAggregateRepository({
      eventStore: deps.eventStore,
      codec: createPassthroughDomainEventCodec<ShippingAddressEvent>(),
      initialState: () => initialShippingAddressBookState,
      evolve: evolveShippingAddressBook,
    }),
    evolve: evolveShippingAddressBook,
    decide: decideShippingAddressBook,
  });

  return {
    commandHandler,
    listShippingAddresses: (accountId, options) => listShippingAddresses(deps.db, accountId, options),
    getShippingAddress: (accountId, shippingAddressId) => getShippingAddress(deps.db, accountId, shippingAddressId),
    projectors: [
      createProjector({
        projectorName: "identity-shipping-address-projection",
        eventStore: deps.eventStore,
        checkpointStore: deps.checkpointStore,
        handlers: buildShippingAddressProjectionHandlers(deps.db),
      }),
    ],
  };
}
