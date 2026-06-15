import { afterEach, describe, expect, it, vi } from "vitest";
import { action } from "../routes/admin/promo-bar";
import type { PromoBarMessage } from "../features/promo-bar/api/contracts";

const staleMessage = {
  id: "pbm_stale",
  title: "Stale loader message",
  description: null,
  href: null,
  link_label: null,
  tone: "info",
  is_active: true,
  display_order: 10,
  starts_at: null,
  ends_at: null,
  created_at: "2026-06-15T00:00:00.000Z",
  updated_at: "2026-06-15T00:00:00.000Z",
} satisfies PromoBarMessage;

const freshMessage = {
  ...staleMessage,
  id: "pbm_fresh",
  title: "Fresh action snapshot",
  updated_at: "2026-06-15T00:01:00.000Z",
} satisfies PromoBarMessage;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("public presence promo bar admin route", () => {
  it("fresh-reads the admin promo bar list after a create action", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST" && url.endsWith("/api/public-presence/admin/promo-bar-messages")) {
        return new Response(JSON.stringify({ ...freshMessage, title: "Created message" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (url.endsWith("/api/public-presence/admin/promo-bar-messages")) {
        return new Response(JSON.stringify({ items: [freshMessage] }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response("unexpected request", { status: 500 });
    });
    vi.stubGlobal("fetch", fetch);

    const result = await action({
      request: new Request("https://admin.chasesets.test/promo-bar", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          intent: "create",
          title: "Created message",
          tone: "success",
          isActive: "true",
          displayOrder: "20",
        }),
      }),
      params: {},
      context: undefined,
    } as never);

    expect(result).toMatchObject({
      message: "Promo bar message created.",
      items: [{ id: "pbm_fresh", title: "Fresh action snapshot" }],
    });
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "https://admin.chasesets.test/api/public-presence/admin/promo-bar-messages",
      expect.objectContaining({ credentials: "include" }),
    );
  });
});
