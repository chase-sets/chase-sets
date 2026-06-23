// @vitest-environment jsdom

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationCenterShell } from "./notification-center-shell";

const mocks = vi.hoisted(() => {
  return {
    sheetProps: {
      current: null as null | Record<string, unknown>,
    },
    api: {
      listCenterFeed: vi.fn(),
      markRead: vi.fn(),
      markAllRead: vi.fn(),
      listPreferences: vi.fn(),
      setPreference: vi.fn(),
    },
  };
});

vi.mock("@chase-sets/design-system", () => ({
  NotificationCenterSheet: (props: Record<string, unknown>) => {
    mocks.sheetProps.current = props;
    return <div data-testid="notification-center-sheet" />;
  },
}));

vi.mock("../../../client", () => ({
  createNotificationCenterApiClient: () => mocks.api,
}));

type NotificationProps = Readonly<{
  unreadCount: number;
  notifications: readonly Readonly<{
    deliveryId: string;
    read: boolean;
  }>[];
  preferences: readonly Readonly<{
    key: string;
    enabled: boolean;
  }>[];
  onMarkRead: (deliveryId: string) => Promise<void>;
  onMarkAllRead: () => Promise<void>;
  onPreferenceChange: (key: string, enabled: boolean) => Promise<void>;
}>;

function feedSnapshot(readAt: string | null, unread: number) {
  return {
    items: [
      {
        deliveryId: "del_1",
        messageType: "ordering.order.created",
        criticality: "commerce",
        title: "Order confirmed",
        body: "Your order is ready.",
        actionHref: "/account/purchases/ord_1",
        readAt,
        createdAt: "2026-05-13T00:00:00.000Z",
      },
    ],
    count: 1,
    unread,
  };
}

function currentProps() {
  if (!mocks.sheetProps.current) {
    throw new Error("NotificationCenterSheet did not render.");
  }

  return mocks.sheetProps.current as NotificationProps;
}

describe("notification center shell post-write consistency", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ items: [] })),
    );
    mocks.sheetProps.current = null;
    mocks.api.listCenterFeed.mockResolvedValue(feedSnapshot(null, 1));
    mocks.api.markRead.mockReset();
    mocks.api.markAllRead.mockReset();
    mocks.api.listPreferences.mockResolvedValue({
      items: [{ key: "email", enabled: true }],
    });
    mocks.api.setPreference.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("reconciles notification read actions from the committed mutation snapshot", async () => {
    mocks.api.markRead.mockResolvedValue({
      status: "read",
      feed: feedSnapshot("2026-05-13T00:05:00.000Z", 0),
    });

    render(<NotificationCenterShell open />);

    await waitFor(() => expect(currentProps().unreadCount).toBe(1));
    expect(currentProps().notifications[0]?.read).toBe(false);

    await act(async () => {
      await currentProps().onMarkRead("del_1");
    });

    expect(mocks.api.markRead).toHaveBeenCalledWith("del_1");
    await waitFor(() => expect(currentProps().unreadCount).toBe(0));
    expect(currentProps().notifications[0]?.read).toBe(true);
  });

  it("keeps the current feed snapshot when a read action fails", async () => {
    mocks.api.markRead.mockRejectedValue(new Error("network failed"));

    render(<NotificationCenterShell open />);

    await waitFor(() => expect(currentProps().unreadCount).toBe(1));

    await act(async () => {
      await currentProps().onMarkRead("del_1");
    });

    expect(currentProps().unreadCount).toBe(1);
    expect(currentProps().notifications[0]?.read).toBe(false);
  });

  it("reconciles preferences from saved snapshots and preserves state on failed writes", async () => {
    mocks.api.setPreference
      .mockResolvedValueOnce({ item: { key: "email", enabled: false } })
      .mockRejectedValueOnce(new Error("network failed"));

    render(<NotificationCenterShell open view="settings" />);

    await waitFor(() => expect(currentProps().preferences[0]).toMatchObject({ key: "email", enabled: true }));

    await act(async () => {
      await currentProps().onPreferenceChange("email", false);
    });

    await waitFor(() => expect(currentProps().preferences[0]).toMatchObject({ key: "email", enabled: false }));

    await act(async () => {
      await currentProps().onPreferenceChange("email", true);
    });

    expect(currentProps().preferences[0]).toMatchObject({ key: "email", enabled: false });
  });
});
