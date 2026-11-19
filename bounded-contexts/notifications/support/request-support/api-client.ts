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

// A failed Product alerts read keeps the API's status and body, so a read after a write can
// tell a projection that has not caught up yet from a failure.
export class NotificationCenterProductAlertsReadError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`Product alerts request failed with ${status}`);
    this.name = "NotificationCenterProductAlertsReadError";
  }
}

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
        throw new NotificationCenterProductAlertsReadError(response.status, await response.json().catch(() => null));
      }

      return attachResponseMetadata(await response.json(), response) as NotificationCenterProductAlertList;
    },
  };
}
