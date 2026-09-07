export { default as contextManifest } from "./context.json" with { type: "json" };
export { channelProviderRegistry, createChannelProviderRegistry } from "./features/publication-port/api/registry";
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

import { defineBoundedContextModule, type BcContextManifest } from "@chase-sets/bounded-context-module";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { createEventStoreWakeNotificationConfigForSourceContext } from "@chase-sets/platform-runtime/source-context-wake-registry";
import contextManifest from "./context.json" with { type: "json" };
import { buildChannelsApi } from "./api";
import { createChannelConnectionRuntime } from "./features/connections/api/runtime";
import type { ChannelConnectionHostPorts, ChannelsServices } from "./features/connections/domain/contracts";
import { channelProviderRegistry } from "./features/publication-port/api/registry";
import {
  channelConnectionSchemaMigrations,
  channelConnectionSchemaSql,
} from "./features/connections/read-model/schema";

const channelsContextManifest = contextManifest as BcContextManifest;

export const module = defineBoundedContextModule<ChannelsServices, PgTransactionalPool, ChannelConnectionHostPorts>({
  manifest: channelsContextManifest,
  schemaSql: channelConnectionSchemaSql,
  schemaMigrations: channelConnectionSchemaMigrations,
  createServices: (pool, ports) => {
    const connections = createChannelConnectionRuntime(
      {
        eventStore: createPostgresEventStore({
          pool,
          wakeNotifications: createEventStoreWakeNotificationConfigForSourceContext({ sourceContextName: "channels" }),
        }),
        db: pool,
      },
      {
        ...(ports ?? {}),
        setupResolver: ports?.setupResolver ?? channelProviderRegistry.setupResolver,
      },
    );
    return { connections, projectors: connections.projectors };
  },
  buildApis: (services) => [{ mountPath: "/api/channels", contextMountOrdinal: 1, router: buildChannelsApi(services) }],
  projectionHandlerSets: (services) => services.projectors,
});
