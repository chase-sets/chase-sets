export { default as contextManifest } from "./context.json" with { type: "json" };
export { channelProviderRegistry, createChannelProviderRegistry } from "./features/publication-port/api/registry";
export { createChannelListingCompositionRuntime } from "./features/listing-composition/api/runtime";
export { type ChannelListingCompositionServices } from "./features/listing-composition/api/runtime";
export { assertChannelListingDelistDirective } from "./features/listing-composition/domain/codecs";
export {
  buildChannelCategorySourceKeys,
  buildChannelConditionSourceKeys,
  buildChannelGradedAttributeSourceEntries,
  channelCompositionProfileRegistry,
  createChannelCompositionProfileRegistry,
  deriveChannelListingId,
  deriveChannelSelectedOptionKey,
} from "./features/listing-composition/domain/canonical";
export { composeChannelListingPublication } from "./features/listing-composition/domain/compose";
export { parseChannelListingCompositionInput } from "./features/listing-composition/domain/parse";
export { type ChannelMappingCandidate } from "./features/listing-composition/domain/configuration";
export {
  channelCompositionProgrammingErrors,
  channelListingPublishStates,
  channelMappingConfidenceTiers,
  channelMappingDimensions,
  channelMappingReviewStatuses,
  channelPublicationBlockingReasons,
  channelPublicationConfigurationBlockingReasons,
  channelPublicationListingBlockingReasons,
} from "./features/listing-composition/domain/contracts";
export {
  type ChannelCommandRefusal,
  type ChannelCommandResult,
  type ChannelCompositionProfile,
  type ChannelCompositionProfileRegistry,
  type ChannelCompositionProgrammingError,
  type ChannelListingCompositionInput,
  type ChannelListingCompositionResult,
  type ChannelListingDelistDirective,
  type ChannelListingDesiredStateChangedData,
  type ChannelListingEvent,
  type ChannelListingLinkState,
  type ChannelMappingConfidenceTier,
  type ChannelMappingDimension,
  type ChannelMappingResolution,
  type ChannelMappingReviewPage,
  type ChannelMappingReviewStatus,
  type ChannelPublicationAdoption,
  type ChannelPublicationBlockingReason,
  type ChannelPublicationConnectionDetail,
  type ChannelPublicationConnectionSummary,
  type ChannelPublicationOutcome,
  type ChannelPublicationSettings,
  type ChannelReferenceRead,
  type ChannelReferenceResolution,
  type ParseChannelListingCompositionInputResult,
} from "./features/listing-composition/domain/contracts";
export { type ChannelListingReconciliationScope } from "./features/listing-composition/domain/reconciliation";
export { type ChannelEnvironment } from "./features/connections/domain/contracts";
export {
  channelExecutionModes,
  channelPublicationRejectionCodes,
  type ChannelExecutionMode,
  type ChannelFetchBoundedUnknownReason,
  type ChannelProviderDescriptor,
  type ChannelProviderIdentity,
  type ChannelProviderRegistry,
  type ChannelPublicationAttribute,
  type ChannelPublicationCapability,
  type ChannelPublicationDraft,
  type ChannelPublicationPrice,
  type ChannelPublicationRejection,
  type ChannelPublicationRejectionCode,
  type ChannelPublicationResult,
  type ChannelPublicationSuccess,
  type ChannelSaleFetchResult,
  type ChannelSaleLineV1,
  type ChannelStateFetchResult,
  type ChannelStateLineV1,
  type DelistListingInput,
  type PublishListingInput,
  type ResolvedChannelProvider,
  type ResolvedChannelPublication,
  type UpdatePriceQuantityInput,
} from "./features/publication-port/domain/contracts";
export {
  createTcgplayerCsvRuntime,
  type ComposeTcgplayerSyncRunInput,
  type IngestTcgplayerExportSnapshotInput,
  type RunFenceInput,
  type TcgplayerCsvRuntimeDependencies,
  type TcgplayerCsvServices,
} from "./features/tcgplayer-csv/api/runtime";
export {
  composeTcgplayerReservation,
  planStagedImportBatches,
  type ComposedTcgplayerReservation,
  type ComposeTcgplayerReservationInput,
} from "./features/tcgplayer-csv/domain/composition";
export { parseTcgplayerFullExport } from "./features/tcgplayer-csv/domain/csv";
export {
  channelExportCompletenessStates,
  channelExportSurfaces,
  channelSyncRunMemberKinds,
  channelSyncRunStates,
  channelSyncRunTriggers,
  tcgplayerLocalRefusalReasons,
  tcgplayerRowRefusalReasons,
  type ChannelExportCompleteness,
  type ChannelExportSchemaDescriptor,
  type ChannelExportSchemaPin,
  type ChannelExportSurface,
  type ChannelInventorySnapshot,
  type ChannelInventorySnapshotRow,
  type ChannelSyncRun,
  type ChannelSyncRunComposedEvent,
  type ChannelSyncRunEvent,
  type ChannelSyncRunMember,
  type ChannelSyncRunMemberKind,
  type ChannelSyncRunState,
  type ChannelSyncRunTransitionedEvent,
  type ChannelSyncRunTrigger,
  type ManualClaimLeasePolicySnapshot,
  type StagedImportBatch,
  type TcgplayerExportIngestLimits,
  type TcgplayerExportParseResult,
  type TcgplayerImportSummary,
  type TcgplayerLocalRefusalReason,
  type TcgplayerRowRefusalReason,
} from "./features/tcgplayer-csv/domain/contracts";
export { channelSyncRunTransitions, decideChannelSyncRunTransition } from "./features/tcgplayer-csv/domain/lifecycle";
export { tcgplayerStagedImportPolicy } from "./features/tcgplayer-csv/domain/policy";
export { tcgplayerExportSchemaDescriptors } from "./features/tcgplayer-csv/domain/profile";
export { readLatestSnapshotRows, readRun } from "./features/tcgplayer-csv/read-model/queries";

import {
  buildEventReactionsFromManifest,
  buildEventSubscriptionsFromManifest,
  defineBoundedContextModule,
  type BcContextManifest,
} from "@chase-sets/bounded-context-module";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { createEventStoreWakeNotificationConfigForSourceContext } from "@chase-sets/platform-runtime/source-context-wake-registry";
import contextManifest from "./context.json" with { type: "json" };
import { buildChannelsApi } from "./api";
import { createChannelConnectionRuntime } from "./features/connections/api/runtime";
import type { ChannelConnectionHostPorts } from "./features/connections/domain/contracts";
import { createChannelListingCompositionRuntime } from "./features/listing-composition/api/runtime";
import { assertChannelListingDelistDirective } from "./features/listing-composition/domain/codecs";
import { createChannelCompositionProfileRegistry } from "./features/listing-composition/domain/canonical";
import {
  buildChannelCatalogDesiredStateReactionHandlers,
  buildChannelInventoryDesiredStateReactionHandlers,
  buildChannelMarketplaceDesiredStateReactionHandlers,
  buildChannelOwnedDesiredStateReactionHandlers,
} from "./features/listing-composition/integrations/reactions";
import {
  channelListingCompositionSchemaMigrations,
  channelListingCompositionSchemaSql,
} from "./features/listing-composition/read-model/schema";
import {
  buildChannelCatalogFactsProjectionHandlers,
  buildChannelConnectionFactsProjectionHandlers,
  buildChannelInventoryFactsProjectionHandlers,
  buildChannelMarketplaceFactsProjectionHandlers,
} from "./features/listing-composition/read-model/facts-projection";
import { buildChannelListingStateProjectionHandlers } from "./features/listing-composition/read-model/state-projection";
import { buildTcgplayerCsvProjectionHandlers } from "./features/tcgplayer-csv/read-model/projection";
import { channelProviderRegistry } from "./features/publication-port/api/registry";
import { createPolicyRuntime } from "@chase-sets/platform-policy/runtime";
import { createOutboundSyncRuntime } from "./features/outbound-sync/api/runtime";
import { outboundOperationBudgetPolicy } from "./features/outbound-sync/domain/policy";
import {
  buildChannelOutboundOperationReactionHandlers,
  createChannelListingPublicationOutcomeRecorder,
} from "./features/outbound-sync/integrations/listing-composition";
import { outboundSyncSchemaMigrations, outboundSyncSchemaSql } from "./features/outbound-sync/read-model/schema";
import { createTcgplayerCsvRuntime } from "./features/tcgplayer-csv/api/runtime";
import { tcgplayerCompositionProfiles } from "./features/tcgplayer-csv/domain/profile";
import { createTcgplayerClaimedReservationRunSettlementPort } from "./features/tcgplayer-csv/integrations/outbound-sync-settlement";
import { tcgplayerCsvSchemaMigrations, tcgplayerCsvSchemaSql } from "./features/tcgplayer-csv/read-model/schema";
import {
  channelStockAllocationBufferPolicy,
  resolveChannelStockAllocationBufferPolicy,
} from "./features/listing-composition/domain/allocation";
import { platformPolicySchemaSql } from "@chase-sets/platform-policy/schema";
import {
  channelConnectionSchemaMigrations,
  channelConnectionSchemaSql,
} from "./features/connections/read-model/schema";
import type { RecordExternalChannelSale } from "@chase-sets/inventory/server";
import { createChannelReconciliationRuntime } from "./features/reconciliation/api/runtime";
import type { ChannelsServices } from "./support/runtime-support/services";
import { channelOutboundKillSwitchPolicy, channelReconciliationPolicy } from "./features/reconciliation/domain/policy";
import {
  channelReconciliationSchemaMigrations,
  channelReconciliationSchemaSql,
} from "./features/reconciliation/read-model/schema";

const channelsContextManifest = contextManifest as BcContextManifest;

type ChannelsHostPorts = ChannelConnectionHostPorts &
  Readonly<{
    channelSaleRecorder: RecordExternalChannelSale;
    readChannelHealthHold?: (connectionId: string) => Promise<boolean>;
  }>;

export const module = defineBoundedContextModule<ChannelsServices, PgTransactionalPool, ChannelsHostPorts>({
  manifest: channelsContextManifest,
  schemaSql: `${platformPolicySchemaSql}\n${channelConnectionSchemaSql}\n${channelListingCompositionSchemaSql}\n${outboundSyncSchemaSql}\n${tcgplayerCsvSchemaSql}\n${channelReconciliationSchemaSql}`,
  schemaMigrations: [
    ...channelConnectionSchemaMigrations,
    ...channelListingCompositionSchemaMigrations,
    ...outboundSyncSchemaMigrations,
    ...tcgplayerCsvSchemaMigrations,
    ...channelReconciliationSchemaMigrations,
  ],
  createServices: (pool, ports) => {
    if (!ports?.channelSaleRecorder) {
      throw new Error("Channels reconciliation requires the typed Inventory channelSaleRecorder host port.");
    }
    const eventStore = createPostgresEventStore({
      pool,
      wakeNotifications: createEventStoreWakeNotificationConfigForSourceContext({ sourceContextName: "channels" }),
    });
    const connections = createChannelConnectionRuntime(
      {
        eventStore,
        db: pool,
      },
      {
        ...(ports ?? {}),
        setupResolver: ports?.setupResolver ?? channelProviderRegistry.setupResolver,
      },
    );
    const compositionProfiles = createChannelCompositionProfileRegistry(tcgplayerCompositionProfiles);
    const policies = createPolicyRuntime({ eventStore, db: pool });
    const listingComposition = createChannelListingCompositionRuntime({
      eventStore,
      transactionalEventStore: eventStore,
      db: pool,
      profiles: compositionProfiles,
      resolveChannelStockAllocationBufferPolicy: () =>
        resolveChannelStockAllocationBufferPolicy(
          async () => (await policies.resolvePolicy(channelStockAllocationBufferPolicy)).value,
        ),
    });
    const outboundSync = createOutboundSyncRuntime(
      {
        db: pool,
        resolveBudgetPolicy: async () => (await policies.resolvePolicy(outboundOperationBudgetPolicy)).value,
        recordOutcome: createChannelListingPublicationOutcomeRecorder(listingComposition),
        claimedReservationRunSettlement: createTcgplayerClaimedReservationRunSettlementPort(eventStore),
        readAdditionalOutboundHold: async ({ connectionId, providerIdentity }) => {
          let killSwitch = null;
          try {
            killSwitch = (await policies.resolvePolicy(channelOutboundKillSwitchPolicy)).value;
          } catch {
            // An unreadable policy fails closed as an operator hold.
          }
          const sources: ("health" | "operator-kill")[] = [];
          if ((await ports.readChannelHealthHold?.(connectionId)) ?? false) sources.push("health");
          if (
            killSwitch === null ||
            killSwitch.heldConnectionIds.includes(connectionId) ||
            killSwitch.heldProviderKeys.includes(providerIdentity.providerKey)
          ) {
            sources.push("operator-kill");
          }
          return { held: sources.length > 0, sources };
        },
      },
      {
        assertDelistDirective: assertChannelListingDelistDirective,
      },
    );
    const reconciliation = createChannelReconciliationRuntime({
      db: pool,
      eventStore,
      outboundSync,
      channelSaleRecorder: ports.channelSaleRecorder,
      resolvePolicy: async () => {
        const resolved = await policies.resolvePolicy(channelReconciliationPolicy);
        const document = resolved.documentId === null ? null : await policies.getPolicyDocument(resolved.documentId);
        return { value: resolved.value, revision: document?.history?.length ?? 0 };
      },
      resolveKillSwitch: async () => (await policies.resolvePolicy(channelOutboundKillSwitchPolicy)).value,
      ...(ports.readChannelHealthHold ? { readHealthHold: ports.readChannelHealthHold } : {}),
    });
    const tcgplayerCsv = createTcgplayerCsvRuntime({
      db: pool,
      eventStore,
      transactionalEventStore: eventStore,
      outboundSync,
      listingComposition,
      providerRegistry: channelProviderRegistry,
      compositionProfiles,
    });
    return {
      connections,
      listingComposition,
      outboundSync,
      reconciliation,
      tcgplayerCsv,
      db: pool,
      projectors: [
        ...connections.projectors,
        ...listingComposition.projectors,
        ...policies.projectors,
        ...tcgplayerCsv.projectors,
      ],
    };
  },
  buildApis: (services) => [{ mountPath: "/api/channels", contextMountOrdinal: 1, router: buildChannelsApi(services) }],
  projectionHandlerSets: (services) => services.projectors,
  buildSubscriptions: (services) => [
    ...buildEventSubscriptionsFromManifest({
      contextName: "channels",
      manifest: channelsContextManifest,
      handlers: {
        "marketplace.channel-marketplace-publication-facts": () =>
          buildChannelMarketplaceFactsProjectionHandlers(services.db),
        "catalog.channel-catalog-publication-facts": () => buildChannelCatalogFactsProjectionHandlers(services.db),
        "inventory.channel-inventory-publication-facts": () =>
          buildChannelInventoryFactsProjectionHandlers(services.db),
        "channels.channel-owned-publication-state": () => ({
          ...buildChannelConnectionFactsProjectionHandlers(services.db),
          ...buildChannelListingStateProjectionHandlers(services.db),
        }),
        "channels.tcgplayer-csv-projection": () => buildTcgplayerCsvProjectionHandlers(services.db),
      },
    }),
    ...buildEventReactionsFromManifest({
      contextName: "channels",
      manifest: channelsContextManifest,
      handlers: {
        "marketplace.channel-listing-desired-state-reaction": () =>
          buildChannelMarketplaceDesiredStateReactionHandlers(services.db, services.listingComposition),
        "catalog.channel-listing-desired-state-reaction": () =>
          buildChannelCatalogDesiredStateReactionHandlers(services.db, services.listingComposition),
        "inventory.channel-listing-desired-state-reaction": () =>
          buildChannelInventoryDesiredStateReactionHandlers(services.db, services.listingComposition),
        "channels.channel-listing-desired-state-reaction": () =>
          buildChannelOwnedDesiredStateReactionHandlers(services.listingComposition),
        "channels.channel-outbound-operation-enqueue": () =>
          buildChannelOutboundOperationReactionHandlers(services.outboundSync),
      },
    }),
  ],
});
