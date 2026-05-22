import { t } from "@chase-sets/localization";
import { BulkActionBar, Button } from "@chase-sets/design-system";
import type { CatalogRealtimeRevalidationState } from "./realtime-revalidation";

export type CatalogRealtimeReloadActionBarProps = Pick<
  CatalogRealtimeRevalidationState,
  "pendingChangeCount" | "syncRequired" | "reload"
> &
  Readonly<{
    entityName: string;
  }>;

export function CatalogRealtimeReloadActionBar({
  pendingChangeCount,
  syncRequired,
  reload,
  entityName,
}: CatalogRealtimeReloadActionBarProps) {
  if (pendingChangeCount === 0 && !syncRequired) {
    return null;
  }

  return (
    <BulkActionBar
      count={Math.max(1, pendingChangeCount)}
      formatSelectedLabel={() =>
        pendingChangeCount > 0
          ? t("catalog.support.shellSupport.ui.realtimeReloadActionBar.changed", {
              count: String(pendingChangeCount),
              entityName,
            })
          : t("catalog.support.shellSupport.ui.realtimeReloadActionBar.sync.required", {
              entityName,
            })
      }
      primaryActions={
        <Button size="sm" tone="primary" leadingIcon="refreshCcw" onClick={reload}>
          {t("catalog.support.shellSupport.ui.realtimeReloadActionBar.reload")}
        </Button>
      }
    />
  );
}
