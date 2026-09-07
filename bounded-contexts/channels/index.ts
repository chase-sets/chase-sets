export { default as contextManifest } from "./context.json" with { type: "json" };
export { channelProviderRegistry, createChannelProviderRegistry } from "./features/publication-port/api/registry";
export { createChannelListingCompositionRuntime } from "./features/listing-composition/api/runtime";
export { type ChannelListingCompositionServices } from "./features/listing-composition/api/runtime";
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
import type { ChannelConnectionHostPorts, ChannelsServices } from "./features/connections/domain/contracts";
import {
  createChannelListingCompositionRuntime,
  type ChannelListingCompositionServices,
} from "./features/listing-composition/api/runtime";
import { channelCompositionProfileRegistry } from "./features/listing-composition/domain/canonical";
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
import { channelProviderRegistry } from "./features/publication-port/api/registry";
import {
  channelConnectionSchemaMigrations,
  channelConnectionSchemaSql,
} from "./features/connections/read-model/schema";

const channelsContextManifest = contextManifest as BcContextManifest;
type ChannelsRuntimeServices = ChannelsServices &
  Readonly<{ listingComposition: ChannelListingCompositionServices; db: PgTransactionalPool }>;

export const module = defineBoundedContextModule<
  ChannelsRuntimeServices,
  PgTransactionalPool,
  ChannelConnectionHostPorts
>({
  manifest: channelsContextManifest,
  schemaSql: `${channelConnectionSchemaSql}\n${channelListingCompositionSchemaSql}`,
  schemaMigrations: [...channelConnectionSchemaMigrations, ...channelListingCompositionSchemaMigrations],
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
    const listingComposition = createChannelListingCompositionRuntime({
      eventStore,
      db: pool,
      profiles: channelCompositionProfileRegistry,
    });
    return {
      connections,
      listingComposition,
      db: pool,
      projectors: [...connections.projectors, ...listingComposition.projectors],
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
      },
    }),
  ],
});
