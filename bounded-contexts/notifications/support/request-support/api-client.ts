import { attachResponseMetadata } from "@chase-sets/http/responses";
import { createForwardedAuthFetch, resolveRequestApiBaseUrl } from "@chase-sets/platform-runtime/http";
import { createNotificationCenterApiClient } from "../../client";

// The notification-center settings view reads the account's Product Alert summary from
// Discovery's Marketplace-mounted endpoint. Discovery owns the behavior; this projection
// covers only the fields the settings view renders.
export type NotificationCenterProductAlert = Readonly<{
  alert_id: string;
  catalog_catalog_item_id: string;
  product_id: string;
  product_summary: string | null;
  market_side: "listing" | "offer";
  threshold_amount: string | null;
  status: "active" | "paused";
}>;

export type NotificationCenterProductAlertList = Readonly<{
  items: readonly NotificationCenterProductAlert[];
}>;

export function createNotificationCenterRequestApiClient(request: Request) {
  return createNotificationCenterApiClient({
    baseUrl: resolveRequestApiBaseUrl(request, "/api/notifications"),
    fetch: createForwardedAuthFetch(request, globalThis.fetch, { readTargetContextName: "notifications" }),
  });
}

export function createNotificationCenterProductAlertsRequestClient(request: Request) {
  const baseUrl = resolveRequestApiBaseUrl(request, "/api/marketplace");
  const forwardedFetch = createForwardedAuthFetch(request, globalThis.fetch, { readTargetContextName: "discovery" });

  return {
    async listProductAlerts(): Promise<NotificationCenterProductAlertList> {
      const response = await forwardedFetch(`${baseUrl}/account/product-alerts`);
      if (!response.ok) {
        throw new Error(`Product alerts request failed with ${response.status}`);
      }

      return attachResponseMetadata(await response.json(), response) as NotificationCenterProductAlertList;
    },
  };
}
