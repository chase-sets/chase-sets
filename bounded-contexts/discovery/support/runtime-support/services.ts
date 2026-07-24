import {
  createPostgresEventStore,
  createPostgresProjectionStore,
  type PgTransactionalPool,
  type PgQueryable,
} from "@chase-sets/event-core-postgres";
import { createEventStoreWakeNotificationConfigForSourceContext } from "@chase-sets/platform-runtime/source-context-wake-registry";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { RateLimitRuleResolver } from "@chase-sets/http/rate-limit";
import type { NotificationOutbox } from "@chase-sets/outbound-messaging";
import { createPostgresNotificationOutbox } from "@chase-sets/notification-outbox";
import { createDiscoveryBrowseRuntime, type DiscoveryBrowseServices } from "../../features/browse/api/runtime";
import { createDiscoveryCategoryRuntime, type DiscoveryCategoryServices } from "../../features/categories/api/runtime";
import { createProductAlertRuntime, type ProductAlertServices } from "../../features/product-alerts/api/runtime";
import { buildGoogleShoppingFeedRowProjectionHandlers } from "../../features/google-shopping-operations/api/projection";
import {
  createGoogleShoppingSyncRuntime,
  type GoogleShoppingSyncServices,
} from "../../features/google-shopping-operations/api/sync-job";
import { createDiscoveryItemRuntime, type DiscoveryItemsServices } from "../item-support/runtime";
import {
  DISCOVERY_SEARCH_EMBEDDINGS_ENV_VAR,
  DISCOVERY_SEARCH_HYBRID_ENV_VAR,
  DISCOVERY_SEARCH_RESCUE_ENV_VAR,
  discoverySearchEmbeddingEnrichmentEnabled,
  discoverySearchHybridEnabled,
  discoverySearchRescueEnabled,
} from "../../features/search/domain/embedding-rollout";
import { createQueryEmbeddingCache } from "../../features/search/domain/query-embedding-cache";
import {
  createVoyageEmbeddingProvider,
  type DiscoveryEmbeddingProvider,
} from "../../features/search/integrations/voyage-embedding-provider";
import {
  createDiscoverySearchEmbeddingEnrichment,
  type DiscoverySearchEmbeddingEnrichment,
} from "../../features/search/read-model/embedding-enrichment";
import type { DiscoverySearchQuerySignal } from "../../features/search/api/runtime";
import {
  createSavedListPickerRuntime,
  type SavedListPickerServices,
} from "../../features/saved-list-addition/api/runtime";
import { buildDiscoverySavedListPickerProjectionHandlers } from "../../features/saved-list-addition/integrations/collections/projection";

export type DiscoveryHostPorts = Readonly<{
  notificationOutbox?: NotificationOutbox;
  searchEmbeddingConfig?: Readonly<{
    apiKey?: string | null;
    model?: string;
    batchSize?: number;
    timeoutMs?: number;
    maxAttempts?: number;
    retryBackoffBaseMs?: number;
    retryBackoffMaxMs?: number;
    rolloutValue?: string | null;
    rescueValue?: string | null;
    hybridValue?: string | null;
    queryCacheMaxEntries?: number;
    queryCacheTtlMs?: number;
  }>;
  searchEmbeddingProvider?: DiscoveryEmbeddingProvider;
  searchTelemetry?: Readonly<{
    recordSearchQuery: (signal: DiscoverySearchQuerySignal) => void;
  }>;
  rateLimitPolicyResolver?: RateLimitRuleResolver;
}>;

export type DiscoveryServices = Readonly<{
  browse: DiscoveryBrowseServices;
  categories: DiscoveryCategoryServices;
  items: DiscoveryItemsServices;
  googleShoppingSync: GoogleShoppingSyncServices;
  productAlerts: ProductAlertServices;
  savedListPicker: SavedListPickerServices;
  searchEmbeddings?: DiscoverySearchEmbeddingEnrichment;
  notificationOutbox: NotificationOutbox;
  rateLimitPolicyResolver?: RateLimitRuleResolver;
  projectors: readonly ProjectionHandlerSet[];
  db: PgQueryable;
  pool: PgTransactionalPool;
}>;

export function createDiscoveryServices(pool: PgTransactionalPool, ports: DiscoveryHostPorts = {}): DiscoveryServices {
  const eventStore = createPostgresEventStore({
    pool,
    wakeNotifications: createEventStoreWakeNotificationConfigForSourceContext({ sourceContextName: "discovery" }),
  });
  const checkpointStore = createPostgresProjectionStore({ db: pool });
  const db = pool as PgQueryable;
  const deps = { eventStore, checkpointStore, db, pool } as const;
  const notificationOutbox = ports.notificationOutbox ?? createPostgresNotificationOutbox({ db });
  const browse = createDiscoveryBrowseRuntime(deps);
  const categories = createDiscoveryCategoryRuntime(deps);
  const googleShoppingSync = createGoogleShoppingSyncRuntime({ db });
  const googleShoppingProjectors = [
    createProjectionHandlerSet({
      projectionName: "discovery-google-shopping-feed-row-projection",
      handlers: buildGoogleShoppingFeedRowProjectionHandlers(db),
    }),
  ];
  const productAlerts = createProductAlertRuntime(deps);
  const savedListPicker = createSavedListPickerRuntime(db);
  const savedListPickerProjectors = [
    createProjectionHandlerSet({
      projectionName: "discovery-saved-list-picker-projection",
      handlers: buildDiscoverySavedListPickerProjectionHandlers(db),
    }),
  ];
  const embeddingConfig = ports.searchEmbeddingConfig;
  const embeddingRolloutEnabled = discoverySearchEmbeddingEnrichmentEnabled({
    [DISCOVERY_SEARCH_EMBEDDINGS_ENV_VAR]: embeddingConfig?.rolloutValue ?? undefined,
  });
  const embeddingProvider =
    ports.searchEmbeddingProvider ??
    (embeddingRolloutEnabled && embeddingConfig?.apiKey
      ? createVoyageEmbeddingProvider({
          apiKey: embeddingConfig.apiKey,
          model: embeddingConfig.model,
          batchSize: embeddingConfig.batchSize,
          timeoutMs: embeddingConfig.timeoutMs,
          maxAttempts: embeddingConfig.maxAttempts,
          retryBackoffBaseMs: embeddingConfig.retryBackoffBaseMs,
          retryBackoffMaxMs: embeddingConfig.retryBackoffMaxMs,
        })
      : undefined);
  const searchEmbeddings =
    embeddingRolloutEnabled && embeddingProvider
      ? createDiscoverySearchEmbeddingEnrichment({ db, provider: embeddingProvider })
      : undefined;
  const retrievalProvider = embeddingRolloutEnabled ? embeddingProvider : undefined;
  const items = createDiscoveryItemRuntime(deps, {
    provider: retrievalProvider,
    cache: retrievalProvider
      ? createQueryEmbeddingCache({
          maxEntries: embeddingConfig?.queryCacheMaxEntries,
          ttlMs: embeddingConfig?.queryCacheTtlMs,
        })
      : undefined,
    rescueEnabled:
      embeddingRolloutEnabled &&
      discoverySearchRescueEnabled({
        [DISCOVERY_SEARCH_RESCUE_ENV_VAR]: embeddingConfig?.rescueValue ?? undefined,
      }),
    hybridEnabled:
      embeddingRolloutEnabled &&
      discoverySearchHybridEnabled({
        [DISCOVERY_SEARCH_HYBRID_ENV_VAR]: embeddingConfig?.hybridValue ?? undefined,
      }),
    recordSearchQuery: ports.searchTelemetry?.recordSearchQuery,
  });

  return {
    browse,
    categories,
    items,
    googleShoppingSync,
    productAlerts,
    savedListPicker,
    ...(searchEmbeddings ? { searchEmbeddings } : {}),
    notificationOutbox,
    rateLimitPolicyResolver: ports.rateLimitPolicyResolver,
    projectors: [
      ...items.projectors,
      ...googleShoppingProjectors,
      ...categories.projectors,
      ...productAlerts.projectors,
      ...savedListPickerProjectors,
    ],
    db,
    pool,
  };
}
