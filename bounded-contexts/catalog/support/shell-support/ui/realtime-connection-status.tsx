import { formatDateTime, t } from "@chase-sets/localization";
import { Button, ConnectionStatusIndicator, type ConnectionLiveStatus } from "@chase-sets/design-system";

export type CatalogRealtimeConnectionStatusProps = Readonly<{
  status: ConnectionLiveStatus;
  staleSince: Date | null;
  reload: () => void;
}>;

// Shared DS live/stale pattern, bound to the realtime route's actual SSE
// connection health rather than to patch activity — a healthy
// connection with nothing to patch stays "live"; a killed connection reads as
// "stale since <time>" even if no patch was ever missed.
export function CatalogRealtimeConnectionStatus({ status, staleSince, reload }: CatalogRealtimeConnectionStatusProps) {
  return (
    <ConnectionStatusIndicator
      status={status}
      liveLabel={t("catalog.support.shellSupport.ui.realtimeConnectionStatus.live")}
      connectingLabel={t("catalog.support.shellSupport.ui.realtimeConnectionStatus.connecting")}
      staleLabel={t("catalog.support.shellSupport.ui.realtimeConnectionStatus.staleSince", {
        value: staleSince ? formatDateTime(staleSince.toISOString()) : "",
      })}
      staleDescription={t("catalog.support.shellSupport.ui.realtimeConnectionStatus.staleDescription")}
      action={
        <Button size="sm" tone="secondary" leadingIcon="refreshCcw" onClick={reload}>
          {t("catalog.support.shellSupport.ui.realtimeReloadActionBar.reload")}
        </Button>
      }
    />
  );
}
