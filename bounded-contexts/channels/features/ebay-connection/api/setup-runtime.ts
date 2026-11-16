import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { parseIsoUtcTimestamp } from "@chase-sets/primitives/iso-utc-timestamp";
import {
  createPostgresEventStore,
  type PgQueryable,
  type PgTransactionalPool,
  type PostgresEventStore,
} from "@chase-sets/event-core-postgres";
import { createChannelConnectionRuntime, loadOwned } from "../../connections/api/runtime";
import { createConnectionEpochs, type ConnectionEpochs } from "../../connections/api/owner-epochs";
import type {
  ChannelConnectionBinding,
  ChannelStorageLocationAuthorityResolver,
} from "../../connections/domain/contracts";
import { ebaySetupDeclaration } from "../domain/configuration";
import { EbaySetupError, materialFingerprint } from "../domain/setup-material";
import {
  ebaySellerSetupSelectedCodec,
  parseSetupCommand,
  parseSetupSelection,
  type SetupSelection,
} from "../domain/setup-selection";
import { readSetupSelection, resolveEbaySetupPolicy } from "../read-model/setup-selection";
import { readSetupLists, type SetupRead } from "./setup-listing";
import type { EbayConnectionServices } from "./runtime";

export function createEbaySellerSetupRuntime(deps: {
  db: PgTransactionalPool;
  eventStore: PostgresEventStore;
  ebayConnection: EbayConnectionServices;
  storageLocationAuthority: ChannelStorageLocationAuthorityResolver;
  connectionEpochs?: ConnectionEpochs;
  read?: SetupRead;
  now?: () => Date;
}) {
  const epochs = deps.connectionEpochs ?? createConnectionEpochs(deps.db);
  const now = deps.now ?? (() => new Date());
  type Target = { accountId: string; connectionId: string };
  return {
    async load(target: Target) {
      return deps.ebayConnection.withSellerSetupCredential(target, async (db, _envelope, material) => {
        const store = createPostgresEventStore({
          pool: { query: db.query.bind(db), connect: deps.db.connect.bind(deps.db) },
        });
        const { state } = await loadOwned(store, target.accountId, target.connectionId);
        if (
          state.providerKey !== "ebay" ||
          state.environment !== "sandbox" ||
          !["pending-setup", "active"].includes(state.status!)
        )
          throw new EbaySetupError("invalid-selection");
        return {
          selection: await readSetupSelection(db, target.accountId, target.connectionId),
          lists: await readSetupLists(material.accessToken, deps.read),
        };
      });
    },
    async select(target: Target, value: unknown, context: EventStoreContext) {
      const command = parseSetupCommand(value);
      return epochs.transaction([`connection/${target.connectionId}`], (db: PgQueryable) =>
        deps.ebayConnection.withSellerSetupCredential(
          target,
          async (_db, envelope, material) => {
            const reader = createPostgresEventStore({
              pool: { query: db.query.bind(db), connect: deps.db.connect.bind(deps.db) },
            });
            const store: EventStore = {
              readStream: reader.readStream.bind(reader),
              readAll: reader.readAll.bind(reader),
              appendToStream: (input) => deps.eventStore.appendToStreamInTransaction(db, input),
            };
            const { state } = await loadOwned(store, target.accountId, target.connectionId);
            if (
              state.providerKey !== "ebay" ||
              state.environment !== "sandbox" ||
              !["pending-setup", "active"].includes(state.status!)
            )
              throw new EbaySetupError("invalid-selection");
            const previous = await readSetupSelection(db, target.accountId, target.connectionId);
            if ((previous?.setupGeneration ?? 0) !== command.expectedSetupGeneration)
              throw new EbaySetupError("generation-conflict");
            const lists = await readSetupLists(material.accessToken, deps.read);
            if (Object.values(lists).some((list) => list.status !== "complete")) throw new EbaySetupError("incomplete");
            const policies = command.policies.map((choice) => {
              const item = lists[choice.policyType].items.find(
                (item) => item[`${choice.policyType}PolicyId`] === choice.policyId,
              );
              if (!item) throw new EbaySetupError("invalid-selection");
              return { ...choice, materialFingerprint: materialFingerprint(item) };
            });
            const bindings: ChannelConnectionBinding[] = [];
            const locationPairs = [];
            for (const choice of command.locationPairs) {
              const item = lists.locations.items.find(
                (item) => item.merchantLocationKey === choice.merchantLocationKey,
              );
              const authority = await deps.storageLocationAuthority.resolve({
                accountId: target.accountId,
                storageLocationId: choice.storageLocationId,
              });
              if (
                !item ||
                !authority ||
                authority.accountId !== target.accountId ||
                authority.storageLocationId !== choice.storageLocationId ||
                authority.status !== "active"
              )
                throw new EbaySetupError("invalid-selection");
              if (!bindings.some((binding) => binding.storageLocationId === choice.storageLocationId))
                bindings.push({ storageLocationId: choice.storageLocationId, revision: authority.revision });
              locationPairs.push({ ...choice, materialFingerprint: materialFingerprint(item) });
            }
            const selection: SetupSelection = parseSetupSelection({
              connectionId: target.connectionId,
              setupGeneration: command.expectedSetupGeneration + 1,
              policies,
              locationPairs,
            });
            const at = parseIsoUtcTimestamp(now().toISOString());
            const saved = await db.query(
              `INSERT INTO channels_ebay_seller_setup (connection_id,account_id,setup_generation,selection,selected_at)
            VALUES ($1,$2,$3,$4,$5) ON CONFLICT (connection_id) DO UPDATE SET setup_generation=EXCLUDED.setup_generation,selection=EXCLUDED.selection,selected_at=EXCLUDED.selected_at
            WHERE channels_ebay_seller_setup.account_id=EXCLUDED.account_id AND channels_ebay_seller_setup.setup_generation=$6 RETURNING connection_id`,
              [
                target.connectionId,
                target.accountId,
                selection.setupGeneration,
                JSON.stringify(selection),
                at,
                command.expectedSetupGeneration,
              ],
            );
            if (saved.rows.length !== 1) throw new EbaySetupError("generation-conflict");
            await deps.eventStore.appendToStreamInTransaction(db, {
              streamId: `channels.ebay-seller-setup-${target.connectionId}`,
              expectedVersion: command.expectedSetupGeneration || "no_stream",
              events: [
                {
                  ...ebaySellerSetupSelectedCodec.encode({
                    type: "channels.ebay-seller-setup.selected",
                    data: selection,
                  }),
                  occurredAt: at,
                },
              ],
              context,
              wakeSourceContextName: "channels",
            });
            const connections = createChannelConnectionRuntime(
              { db, eventStore: store },
              {
                setupResolver: { resolve: async () => ebaySetupDeclaration },
                credentialAuthority: {
                  resolve: async (reference) =>
                    reference === envelope.rowId &&
                    material.accessExpiresAt &&
                    Date.parse(material.accessExpiresAt) > now().getTime()
                      ? {
                          accountId: envelope.accountId,
                          providerKey: "ebay",
                          environment: "sandbox",
                          generation: envelope.tokenGeneration,
                          status: "current",
                        }
                      : null,
                },
                policyAuthority: { resolve: (input) => resolveEbaySetupPolicy(db, input) },
                storageLocationAuthority: deps.storageLocationAuthority,
              },
            );
            const result = await connections.activateChannelConnection(
              { ...target, credentialReference: envelope.rowId, bindings },
              context,
            );
            return { selection, status: result.state.status };
          },
          db,
        ),
      );
    },
  };
}
export type EbaySellerSetupServices = ReturnType<typeof createEbaySellerSetupRuntime>;
