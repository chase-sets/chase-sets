import { createPostgresEventStore, type PgQueryable, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { RateLimitRuleResolver } from "@chase-sets/http/rate-limit";
import { createEventStoreWakeNotificationConfigForSourceContext } from "@chase-sets/platform-runtime/source-context-wake-registry";
import { createSavedListDiscoveryRuntime } from "../../features/saved-lists/api/discovery-runtime";
import {
  createSavedListSharedAccess,
  type SavedListAbuseReportAdapter,
  type SavedListSharingAuditSink,
  type SavedListSharingRateLimitPort,
} from "../../features/saved-lists/api/shared-access";
import { createSavedListSharingRuntime } from "../../features/saved-lists/api/sharing-runtime";
import { createSavedListRuntime } from "../../features/saved-lists/api/runtime";
import { createSavedListInventoryHandoff } from "../../features/saved-lists/integrations/inventory-handoff";
import type { SavedListInventoryImportBatchCreator } from "../../features/saved-lists/integrations/inventory-handoff";
import type { SavedListProductCatalog } from "../../features/saved-lists/domain/contracts";
import { createSavedListValuationRuntime } from "../../features/saved-list-valuation/api/runtime";
import type { SavedListCapabilityService } from "../../features/saved-lists/domain/sharing-contracts";
import { createSavedListReadModelRuntime } from "../../features/saved-lists/read-model/runtime";
import { buildSavedListSharedPageProjectionHandlers } from "../../features/saved-lists/read-model/shared-page-projection";
import { loadSavedListSharedPage } from "../../features/saved-lists/read-model/shared-page-queries";
import { buildSavedListPickerProjectionHandlers } from "../../features/saved-lists/read-model/picker-projection";

export type CollectionsHostPorts = Readonly<{
  savedListProductCatalog?: SavedListProductCatalog;
  inventorySavedListImportBatchCreator?: SavedListInventoryImportBatchCreator;
  savedListCapabilities?: SavedListCapabilityService;
  savedListSharingRateLimits?: SavedListSharingRateLimitPort;
  savedListSharingAudit?: SavedListSharingAuditSink;
  savedListAbuseReports?: SavedListAbuseReportAdapter;
  rateLimitPolicyResolver?: RateLimitRuleResolver;
}>;

export type CollectionsServices = Readonly<{
  savedLists: ReturnType<typeof createSavedListRuntime>;
  savedListInventory: ReturnType<typeof createSavedListInventoryHandoff>;
  savedListValuation: ReturnType<typeof createSavedListValuationRuntime>;
  savedListReadModels: ReturnType<typeof createSavedListReadModelRuntime>;
  savedListSharing: ReturnType<typeof createSavedListSharingRuntime>;
  savedListSharedAccess: ReturnType<typeof createSavedListSharedAccess>;
  discovery: ReturnType<typeof createSavedListDiscoveryRuntime>;
  projectors: readonly ProjectionHandlerSet[];
  rateLimitPolicyResolver?: RateLimitRuleResolver;
  pool: PgTransactionalPool;
  db: PgQueryable;
}>;

const unavailableProductCatalog: SavedListProductCatalog = {
  resolveProduct: async () => ({ availability: "unavailable", product: null }),
};
const unavailableCapabilities: SavedListCapabilityService = {
  mint: () => {
    throw new Error("Saved List capability service is unavailable.");
  },
  reissue: () => {
    throw new Error("Saved List capability service is unavailable.");
  },
  verifierFor: () => null,
};
const unavailableRateLimits: SavedListSharingRateLimitPort = {
  check: async () => ({ limited: true, retryAfterSeconds: 60 }),
};
const unavailableAudit: SavedListSharingAuditSink = {
  record: async () => {
    throw new Error("Saved List sharing audit sink is unavailable.");
  },
};
const unavailableAbuseReports: SavedListAbuseReportAdapter = {
  submit: async () => {
    throw new Error("Saved List abuse-report adapter is unavailable.");
  },
};

const unavailableInventoryImportBatchCreator: SavedListInventoryImportBatchCreator = async () => {
  throw new Error("Inventory Saved List import is unavailable.");
};

export function createCollectionsServices(
  pool: PgTransactionalPool,
  ports: CollectionsHostPorts = {},
): CollectionsServices {
  const db = pool as PgQueryable;
  const eventStore = createPostgresEventStore({
    pool,
    wakeNotifications: createEventStoreWakeNotificationConfigForSourceContext({ sourceContextName: "collections" }),
  });
  const productCatalog = ports.savedListProductCatalog ?? unavailableProductCatalog;
  const savedLists = createSavedListRuntime({
    eventStore,
    productCatalog,
  });
  const savedListReadModels = createSavedListReadModelRuntime(db);
  const capabilities = ports.savedListCapabilities ?? unavailableCapabilities;
  const savedListSharing = createSavedListSharingRuntime({
    eventStore,
    ownerSnapshots: savedLists,
    capabilities,
  });
  return {
    savedLists,
    savedListInventory: createSavedListInventoryHandoff({
      savedLists,
      inventoryImportBatchCreator: ports.inventorySavedListImportBatchCreator ?? unavailableInventoryImportBatchCreator,
    }),
    savedListValuation: createSavedListValuationRuntime(pool),
    savedListReadModels,
    discovery: createSavedListDiscoveryRuntime({ db, savedLists, productCatalog }),
    savedListSharing,
    savedListSharedAccess: createSavedListSharedAccess({
      sharedPages: { load: (listId) => loadSavedListSharedPage(db, listId) },
      ownerSnapshots: savedLists,
      capabilities,
      rateLimits: ports.savedListSharingRateLimits ?? unavailableRateLimits,
      audit: ports.savedListSharingAudit ?? unavailableAudit,
      abuseReports: ports.savedListAbuseReports ?? unavailableAbuseReports,
    }),
    projectors: [
      ...savedListReadModels.projectors,
      createProjectionHandlerSet({
        projectionName: "collections-saved-list-picker-projection",
        handlers: buildSavedListPickerProjectionHandlers(db),
      }),
      createProjectionHandlerSet({
        projectionName: "collections.saved-list-shared-page-projection",
        handlers: buildSavedListSharedPageProjectionHandlers(db),
      }),
    ],
    rateLimitPolicyResolver: ports.rateLimitPolicyResolver,
    pool,
    db,
  };
}
