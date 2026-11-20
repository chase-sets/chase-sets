import type { module as authModule } from "@chase-sets/auth";
import { createIdentityListingActivationAuthority, type IdentityServices } from "@chase-sets/identity/server";
import type { ChannelsServices } from "@chase-sets/channels/server";
import { createInventoryStockAuthorityForPool } from "@chase-sets/inventory/server";
import {
  createMarketplaceListingConsumer,
  ListingTargetCommandError,
  type ListingTargetAuthority,
  type ListingAuthorizationEvidence,
} from "@chase-sets/marketplace/server";
import {
  createPostgresOwnerStreamReservationStore,
  withConfigurationEpochTransaction,
  type PgQueryable,
  type PgTransactionalPool,
} from "@chase-sets/event-core-postgres";
import {
  reservationIdentity,
  type RequestTerminalBinding,
  type ReserveOwnerStreamInput,
} from "@chase-sets/event-core/owner-stream-reservation";
import { ListingRequestConflictError } from "@chase-sets/marketplace/server";

export function createPlatformListingTargetAuthority(
  input: Readonly<{
    marketplace: PgTransactionalPool;
    inventory: PgTransactionalPool;
    auth: () => ReturnType<typeof authModule.createServices>;
    identity: () => IdentityServices;
    channels: () => ChannelsServices;
  }>,
) {
  const consumer = createMarketplaceListingConsumer(input.marketplace);
  const stock = createInventoryStockAuthorityForPool(input.inventory, input.marketplace);
  const terminals = createPostgresOwnerStreamReservationStore({
    ownerPool: input.inventory,
    consumerPool: input.marketplace,
    applyInvalidation: async () => {
      throw new Error("Only Inventory writers apply stock changes.");
    },
    applyInboundEvidence: async () => {
      throw new Error("Only Inventory records inbound sales.");
    },
  });
  const authority: ListingTargetAuthority = {
    async recoverRequest(request) {
      const identity = await consumer.initialize();
      const values = await Promise.all(
        ["allocation", "item"].map((kind) => terminals.getReservation(`${request.requestId}:${kind}`)),
      );
      if (values.every((value) => value === undefined)) return;
      if (values.some((value) => !value || value.commandFingerprint !== request.commandFingerprint))
        throw new ListingRequestConflictError();
      const reservations = values.flatMap((value) =>
        value
          ? [
              {
                reservationId: value.reservationId,
                operationId: value.operationId,
                ownerStreamId: value.ownerStreamId,
                purpose: value.purpose,
                resourceKey: value.resourceKey,
                consumer: value.consumer,
                seal: value.seal,
                target: value.target,
                commandFingerprint: value.commandFingerprint,
              },
            ]
          : [],
      );
      const prior = await withConfigurationEpochTransaction(input.marketplace, (db: PgQueryable) =>
        db.query<{ binding: RequestTerminalBinding }>(
          "SELECT binding FROM event_request_terminals WHERE consumer_store_id = $1 AND request_id = $2",
          [identity.storeId, request.requestId],
        ),
      );
      const binding: RequestTerminalBinding = prior.rows[0]?.binding ?? {
        consumerStoreId: identity.storeId,
        consumerIncarnation: identity.incarnation,
        requestId: request.requestId,
        commandFingerprint: request.commandFingerprint,
        target: reservations[0].target,
        reservations,
        preparationDeadline: new Date(Date.now() + 60000).toISOString(),
      };
      if (
        binding.commandFingerprint !== request.commandFingerprint ||
        reservationIdentity(binding.reservations) !== reservationIdentity(reservations)
      )
        throw new ListingRequestConflictError();
      await terminals.abortRequestTerminal(binding);
      throw new Error(
        "Prior Listing preparation was settled through its original terminal; use a new command identity.",
      );
    },
    async authorizeManage({ accountId, principal }, context) {
      const identity = await consumer.initialize();
      const sessionAuthority = input.auth().sessionAuthority;
      if (!sessionAuthority) throw new Error("Auth Session authority is unavailable.");
      const sessionInput = { ...principal, tenantId: context.tenantId, consumer: identity };
      await sessionAuthority.registerConsumer(sessionInput);
      const session = await sessionAuthority.capture(sessionInput);
      if (session.kind !== "granted") throw new Error("Session authority is unavailable.");
      const services = input.identity();
      const identityAuthority = createIdentityListingActivationAuthority(
        services.mutationPersistence,
        services.ownerEpochs,
      );
      const identityInput = {
        tenantId: context.tenantId,
        accountId,
        userId: principal.userId,
        membershipId: principal.membershipId,
        consumer: identity,
      };
      await identityAuthority.registerConsumer(identityInput);
      const result = await identityAuthority.capture(identityInput);
      if (result.kind !== "granted") throw new Error("Current listings.manage capability is required.");
      const evidence: ListingAuthorizationEvidence[] = [
        {
          owner: "auth",
          key: `session/${principal.sessionId}`,
          storeIncarnation: session.seal.storeIncarnation,
          sealVersion: session.sessionRevision,
          epoch: session.grant.epoch,
        },
        {
          owner: "auth",
          key: `session-token/${principal.sessionId}`,
          storeIncarnation: session.seal.storeIncarnation,
          sealVersion: Number(session.tokenRevision),
          epoch: session.grant.epoch,
        },
        ...result.grants.map((grant, index) => ({
          owner: "identity",
          key: grant.key,
          storeIncarnation: grant.sourceIncarnation,
          sealVersion: [result.account.seal.version, result.user.seal.version, result.membership.seal.version][index],
          epoch: grant.epoch,
        })),
      ];
      return { grants: [session.grant, ...result.grants], evidence };
    },
    async resolveConnection({ accountId, connectionId }) {
      const identity = await consumer.initialize();
      const source = input.channels().connectionAuthority;
      await source.registerConsumer({ connectionId, consumer: identity });
      const result = await source.capture({ accountId, connectionId, consumer: identity });
      if (result.kind !== "granted") {
        if (result.reason === "connection-not-found") throw new ListingTargetCommandError("connection-not-found");
        throw new Error("Connection authority is unavailable.");
      }
      return {
        grants: [result.grant],
        evidence: [
          {
            owner: "channels",
            key: result.grant.key,
            storeIncarnation: result.seal.storeIncarnation,
            sealVersion: result.version,
            epoch: result.grant.epoch,
          },
        ],
        connection: {
          connectionId,
          providerKey: result.providerKey,
          environment: result.environment,
          identityRevision: result.version,
        },
      };
    },
    async prepareAllocation(request, context) {
      const identity = await consumer.initialize();
      const target = {
        listingId: request.listingId,
        accountId: request.accountId,
        inventoryItemId: request.inventoryItemId,
        channelConnectionId: request.connectionId,
        catalogItemId: request.catalogItemId,
        productId: request.productId,
        selectedOptions: request.selectedOptions,
      };
      const captured = await stock.capture(target, context);
      if (captured.allocation.revision !== request.allocationRevision)
        throw new Error("Inventory allocation revision changed.");
      const reservation = {
        reservationId: request.requestId,
        operationId: request.requestId,
        purpose: "listing-channel-activation",
        consumer: { ...identity, requestId: request.requestId },
        target,
        commandFingerprint: request.commandFingerprint,
      };
      const manifest: ReserveOwnerStreamInput[] = [
        {
          ...reservation,
          reservationId: `${request.requestId}:allocation`,
          ownerStreamId: `inventory.channel-stock-allocation-${request.inventoryItemId}`,
          resourceKey: `stock/${request.accountId}/${request.inventoryItemId}`,
          seal: { version: captured.allocation.revision, storeIncarnation: captured.incarnation },
        },
        {
          ...reservation,
          reservationId: `${request.requestId}:item`,
          ownerStreamId: `inventory.item-${request.inventoryItemId}`,
          resourceKey: `stock/${request.accountId}/${request.inventoryItemId}`,
          seal: { version: captured.itemVersion, storeIncarnation: captured.incarnation },
        },
      ];
      const prior = await withConfigurationEpochTransaction(input.marketplace, async (db: PgQueryable) =>
        db.query<{ binding: RequestTerminalBinding }>(
          "SELECT binding FROM event_request_terminals WHERE consumer_store_id = $1 AND request_id = $2",
          [identity.storeId, request.requestId],
        ),
      );
      const terminal: RequestTerminalBinding = {
        consumerStoreId: identity.storeId,
        consumerIncarnation: identity.incarnation,
        requestId: request.requestId,
        commandFingerprint: request.commandFingerprint,
        target,
        reservations: manifest,
        preparationDeadline: prior.rows[0]?.binding.preparationDeadline ?? new Date(Date.now() + 60000).toISOString(),
      };
      let reservations: readonly ReserveOwnerStreamInput[];
      try {
        reservations = await stock.prepare(captured, reservation, context);
        if (reservationIdentity(reservations) !== reservationIdentity(manifest))
          throw new Error("Inventory preparation differs from the declared manifest.");
        const opened = await terminals.openRequestTerminal(terminal);
        if (opened.status !== "OPEN") throw new Error("Listing request is already terminal.");
      } catch (error) {
        await terminals.abortRequestTerminal(terminal);
        throw error;
      }
      return {
        terminal,
        reservations,
        evidence: reservations.map((value) => ({
          owner: "inventory",
          key: value.ownerStreamId,
          storeIncarnation: value.seal.storeIncarnation,
          sealVersion: value.seal.version,
          promiseId: value.reservationId,
        })),
      };
    },
  };
  return { authority, consumer };
}
