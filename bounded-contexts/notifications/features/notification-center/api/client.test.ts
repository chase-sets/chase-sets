import { describe, expect, it, vi } from "vitest";
import { createNotificationCenterApiClient } from "../../../client";

describe("notification center api client", () => {
  it("returns read mutation snapshots to callers", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        status: "read",
        feed: {
          items: [],
          count: 0,
          unread: 0,
        },
      }),
    );
    const client = createNotificationCenterApiClient({
      baseUrl: "https://api.chasesets.test/api/notifications",
      fetch,
    });

    await expect(client.markRead("del 1")).resolves.toEqual({
      status: "read",
      feed: {
        items: [],
        count: 0,
        unread: 0,
      },
    });

    expect(fetch).toHaveBeenCalledWith("https://api.chasesets.test/api/notifications/center/del%201/read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      credentials: "include",
    });
  });

  it("returns preference mutation snapshots to callers", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        item: {
          key: "email",
          enabled: false,
        },
      }),
    );
    const client = createNotificationCenterApiClient({ fetch });

    await expect(client.setPreference("email", false)).resolves.toEqual({
      item: {
        key: "email",
        enabled: false,
      },
    });

    expect(fetch).toHaveBeenCalledWith("/api/notifications/preferences/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
      credentials: "include",
    });
  });
});
