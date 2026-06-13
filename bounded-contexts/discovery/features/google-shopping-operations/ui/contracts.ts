import type {
  GoogleShoppingFeedRowFilter,
  GoogleShoppingFeedRowList,
  GoogleShoppingFeedRowListItem,
  GoogleShoppingFullSyncJobStatus,
  GoogleShoppingMaintenancePreview,
} from "../../../support/google-shopping-support/sync-job";

export type {
  GoogleShoppingFeedRowFilter,
  GoogleShoppingFeedRowList,
  GoogleShoppingFeedRowListItem,
  GoogleShoppingFullSyncJobStatus,
  GoogleShoppingMaintenancePreview,
};

export type GoogleShoppingOperationsFilters = Readonly<{
  filter: GoogleShoppingFeedRowFilter;
  search: string;
  limit: number;
  refreshWindowDays: number;
  selected: string;
}>;

export type GoogleShoppingOperationsNotice = Readonly<{
  tone: "success" | "warning" | "danger" | "info";
  message: string;
}>;
