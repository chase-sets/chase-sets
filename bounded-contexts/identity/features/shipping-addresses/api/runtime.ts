import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { PostageLabelProvider } from "@chase-sets/postage-labels";
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
import {
  verifyShippingAddressSnapshot,
  type AddressVerificationDecision,
  type ShippingAddressVerificationOutcome,
} from "./address-verification";

export type ShippingAddressServices = Readonly<{
  commandHandler: CommandHandler<ShippingAddressCommand, ShippingAddressBookState, ShippingAddressEvent>;
  getShippingAddressBookState: (accountId: string) => Promise<ShippingAddressBookState | null>;
  listShippingAddresses: (
    accountId: string,
    options?: Parameters<typeof listShippingAddresses>[2],
  ) => ReturnType<typeof listShippingAddresses>;
  getShippingAddress: (accountId: string, shippingAddressId: string) => ReturnType<typeof getShippingAddress>;
  verifyShippingAddress: (
    address: Parameters<typeof verifyShippingAddressSnapshot>[1],
    decision?: AddressVerificationDecision,
  ) => Promise<ShippingAddressVerificationOutcome>;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createShippingAddressRuntime(deps: IdentityRuntimeDeps): ShippingAddressServices {
  const { commandHandler, repository } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<ShippingAddressEvent>(),
    initialState: () => initialShippingAddressBookState,
    evolve: evolveShippingAddressBook,
    decide: decideShippingAddressBook,
  });

  return {
    commandHandler,
    getShippingAddressBookState: async (accountId) => {
      const aggregate = await repository.load(`identity.shipping-address-book-${accountId}`);
      return aggregate.state.accountId ? aggregate.state : null;
    },
    listShippingAddresses: (accountId, options) => listShippingAddresses(deps.db, accountId, options),
    getShippingAddress: (accountId, shippingAddressId) => getShippingAddress(deps.db, accountId, shippingAddressId),
    verifyShippingAddress: (address, decision) =>
      verifyShippingAddressSnapshot(deps.addressVerificationProvider, address, decision ?? null),
    projectors: [
      createProjectionHandlerSet({
        projectionName: "identity-shipping-address-projection",
        handlers: buildShippingAddressProjectionHandlers(deps.db),
      }),
    ],
  };
}
