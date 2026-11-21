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

  function save(values: Record<string, string>, fetch: ReturnType<typeof vi.fn>) {
    vi.stubGlobal("fetch", fetch);
    return action({
      request: new Request("https://admin.chasesets.test/promo-bar", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          intent: "create",
          title: "Fee holiday",
          tone: "info",
          isActive: "true",
          ...values,
        }),
      }),
      params: {},
      context: undefined,
    } as never);
  }

  function api() {
    return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "POST"
        ? new Response(JSON.stringify(freshMessage), { status: 201, headers: { "Content-Type": "application/json" } })
        : new Response(JSON.stringify({ items: [freshMessage] }), { headers: { "Content-Type": "application/json" } }),
    );
  }

  it("sends the start and end the operator's browser read as instants", async () => {
    const fetch = api();
    await save(
      {
        startsAtLocal: "2026-11-10T09:00",
        startsAt: "2026-11-10T15:00:00.000Z",
        endsAtLocal: "",
        endsAt: "",
      },
      fetch,
    );

    const sent = JSON.parse(String((fetch.mock.calls[0]![1] as RequestInit).body)) as Record<string, unknown>;
    expect(sent).toMatchObject({ startsAt: "2026-11-10T15:00:00.000Z", endsAt: null });
  });

  it.each([
    ["a start with no zone", { startsAt: "2026-11-10T09:00" }],
    ["a typed end the browser could not read", { endsAtLocal: "2026-03-08T02:30", endsAt: "" }],
  ])("refuses %s instead of sending it for the API to read in its zone", async (_case, values) => {
    const fetch = api();
    const result = await save(values, fetch);

    expect(result).toMatchObject({
      message: null,
      error: "Enter each start and end as a date and time, or leave it blank. Nothing was saved.",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
