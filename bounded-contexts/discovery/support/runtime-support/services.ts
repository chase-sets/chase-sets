import {
  createPostgresEventStore,
  createPostgresProjectionStore,
  type PgTransactionalPool,
  type PgQueryable,
} from "@chase-sets/event-core-postgres";
import { createEventStoreWakeNotificationConfigForSourceContext } from "@chase-sets/platform-runtime/source-context-wake-registry";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { NotificationOutbox } from "@chase-sets/outbound-messaging";
import { createPostgresNotificationOutbox } from "@chase-sets/notification-outbox";
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
  discoverySearchEmbeddingEnrichmentEnabled,
} from "../../features/search/domain/embedding-rollout";
import {
  createVoyageEmbeddingProvider,
  type DiscoveryEmbeddingProvider,
} from "../../features/search/integrations/voyage-embedding-provider";
import {
  createDiscoverySearchEmbeddingEnrichment,
  type DiscoverySearchEmbeddingEnrichment,
} from "../../features/search/read-model/embedding-enrichment";

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
  }>;
  searchEmbeddingProvider?: DiscoveryEmbeddingProvider;
}>;

export type DiscoveryServices = Readonly<{
  categories: DiscoveryCategoryServices;
  items: DiscoveryItemsServices;
  googleShoppingSync: GoogleShoppingSyncServices;
  productAlerts: ProductAlertServices;
  searchEmbeddings?: DiscoverySearchEmbeddingEnrichment;
  notificationOutbox: NotificationOutbox;
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
  const deps = { eventStore, checkpointStore, db } as const;
  const notificationOutbox = ports.notificationOutbox ?? createPostgresNotificationOutbox({ db });
  const categories = createDiscoveryCategoryRuntime(deps);
  const items = createDiscoveryItemRuntime(deps);
  const googleShoppingSync = createGoogleShoppingSyncRuntime({ db });
  const googleShoppingProjectors = [
    createProjectionHandlerSet({
      projectionName: "discovery-google-shopping-feed-row-projection",
      handlers: buildGoogleShoppingFeedRowProjectionHandlers(db),
    }),
  ];
  const productAlerts = createProductAlertRuntime(deps);
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

  return {
    categories,
    items,
    googleShoppingSync,
    productAlerts,
    ...(searchEmbeddings ? { searchEmbeddings } : {}),
    notificationOutbox,
    projectors: [
      ...items.projectors,
      ...googleShoppingProjectors,
      ...categories.projectors,
      ...productAlerts.projectors,
    ],
    db,
    pool,
  };
}
