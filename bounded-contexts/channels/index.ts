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
export {
  channelExecutionModes,
  channelPublicationRejectionCodes,
  type ChannelExecutionMode,
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
  type DelistListingInput,
  type PublishListingInput,
  type ResolvedChannelProvider,
  type ResolvedChannelPublication,
  type UpdatePriceQuantityInput,
} from "./features/publication-port/domain/contracts";
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
import { createChannelListingPublicationOutcomeRecorder } from "./features/outbound-sync/integrations/listing-composition";
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
import type { ChannelsServices } from "./support/runtime-support/services";
import type { MarketplaceChannelInboundClampCapability } from "./support/request-support/marketplace-channel-inbound-clamp";
import { createManualSyncRuntime, type ManualSyncServices } from "./features/manual-sync/api/runtime";
import { inspectManualSyncSeedState, seedManualSyncScenario } from "./features/manual-sync/api/seed";
import { manualSyncSchemaMigrations, manualSyncSchemaSql } from "./features/manual-sync/read-model/schema";
import { manualSyncRetentionExemptions } from "./features/manual-sync/read-model/retention-policy";

const channelsContextManifest = contextManifest as BcContextManifest;
type ChannelsRuntimeServices = ChannelsServices &
  Readonly<{
    manualSync: ManualSyncServices;
  }>;
type ChannelsHostPorts = ChannelConnectionHostPorts &
  Readonly<{ marketplaceChannelInboundClamp?: MarketplaceChannelInboundClampCapability }>;

export const module = defineBoundedContextModule<ChannelsRuntimeServices, PgTransactionalPool, ChannelsHostPorts>({
  manifest: channelsContextManifest,
  schemaSql: `${platformPolicySchemaSql}\n${channelConnectionSchemaSql}\n${channelListingCompositionSchemaSql}\n${outboundSyncSchemaSql}\n${tcgplayerCsvSchemaSql}\n${manualSyncSchemaSql}`,
  schemaMigrations: [
    ...channelConnectionSchemaMigrations,
    ...channelListingCompositionSchemaMigrations,
    ...outboundSyncSchemaMigrations,
    ...tcgplayerCsvSchemaMigrations,
    ...manualSyncSchemaMigrations,
  ],
  retentionExemptions: manualSyncRetentionExemptions,
  seedProfiles: ["scenario-seed"],
  seed: (pool, services) => seedManualSyncScenario(pool, services),
  inspectSeedState: inspectManualSyncSeedState,
  createServices: (pool, ports) => {
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
      },
      {
        assertDelistDirective: assertChannelListingDelistDirective,
      },
    );
    const tcgplayerCsv = createTcgplayerCsvRuntime({
      db: pool,
      eventStore,
      transactionalEventStore: eventStore,
      outboundSync,
      listingComposition,
      providerRegistry: channelProviderRegistry,
      compositionProfiles,
    });
    const manualSync = createManualSyncRuntime({
      db: pool,
      connections,
      tcgplayerCsv,
      policies,
      marketplaceClamp: ports?.marketplaceChannelInboundClamp ?? { kind: "not-mounted" },
    });
    return {
      connections,
      listingComposition,
      outboundSync,
      tcgplayerCsv,
      manualSync,
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
          buildChannelOwnedDesiredStateReactionHandlers(services.listingComposition, services.outboundSync),
      },
    }),
  ],
});
