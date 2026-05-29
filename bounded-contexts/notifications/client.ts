import { attachResponseMetadata } from "@chase-sets/http/responses";

export type NotificationCenterFeedItem = Readonly<{
  deliveryId: string;
  messageType: string;
  criticality: string;
  title: string;
  body: string;
  actionHref: string | null;
  readAt: string | null;
  createdAt: string;
}>;

export type NotificationCenterFeedResponse = Readonly<{
  items: readonly NotificationCenterFeedItem[];
  count: number;
  unread: number;
}>;

export type NotificationPreference = Readonly<{
  key: "web" | "email" | "product-alerts";
  enabled: boolean;
}>;

export interface NotificationCenterApiClientOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  credentials?: RequestCredentials;
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(`Notifications API request failed with ${response.status}`);
  }

  return attachResponseMetadata(await response.json(), response) as T;
}

export function createNotificationCenterApiClient({
  baseUrl = "/api/notifications",
  fetch = globalThis.fetch,
  credentials = "include",
}: NotificationCenterApiClientOptions = {}) {
  const request: typeof globalThis.fetch = (input, init = {}) =>
    fetch(input, {
      ...init,
      credentials: init.credentials ?? credentials,
    });

  return {
    async listCenterFeed(query = "limit=25&includeRead=true") {
      const suffix = query ? `?${query.replace(/^\?/, "")}` : "";
      return parseJsonResponse<NotificationCenterFeedResponse>(await request(`${baseUrl}/center${suffix}`));
    },
    async markRead(deliveryId: string) {
      return parseJsonResponse<{ status: string }>(
        await request(`${baseUrl}/center/${encodeURIComponent(deliveryId)}/read`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }),
      );
    },
    async markAllRead() {
      return parseJsonResponse<{ status: string }>(
        await request(`${baseUrl}/center/read-all`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }),
      );
    },
    async listPreferences() {
      return parseJsonResponse<{ items: readonly NotificationPreference[] }>(await request(`${baseUrl}/preferences`));
    },
    async setPreference(key: NotificationPreference["key"], enabled: boolean) {
      return parseJsonResponse<{ item: NotificationPreference }>(
        await request(`${baseUrl}/preferences/${encodeURIComponent(key)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled }),
        }),
      );
    },
  };
}

export const notificationCenterApi = createNotificationCenterApiClient();
