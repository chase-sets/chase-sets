import { afterEach, describe, expect, it, vi } from "vitest";
import { createReportedContentApiClient } from "../../support/request-support/reported-content-client";
import { action } from "./reported-content-detail";

const acknowledgedAt = "2026-11-16T16:00:00.000Z";

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function acknowledgeRequest() {
  return new Request("https://admin.example.test/reported-content/listing/lst_1", {
    method: "POST",
    body: new URLSearchParams({ action: "acknowledge" }),
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("Reported Content acknowledgement delivery", () => {
  it("posts to the encoded target and returns the authoritative acknowledgement", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response({ acknowledgedAt }));
    const client = createReportedContentApiClient({ baseUrl: "https://api.example.test", fetch });
    await expect(client.acknowledgeReportedContent("account-profile", "acc/1")).resolves.toEqual({ acknowledgedAt });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      "https://api.example.test/reported-content/account-profile/acc%2F1/acknowledge",
      { method: "POST" },
    );
  });

  it("the admin action acknowledges once and redirects to its existing detail route", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response({ acknowledgedAt }));
    vi.stubGlobal("fetch", fetch);
    const result = await action({
      request: acknowledgeRequest(),
      params: { targetType: "listing", targetId: "lst_1" },
      context: undefined,
    } as never);
    expect(result.status).toBe(302);
    expect(result.headers.get("Location")).toBe("/support/reported-content/listing/lst_1");
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toMatch(/\/reported-content\/listing\/lst_1\/acknowledge$/);
    expect(init?.method).toBe("POST");
  });

  it("records a moderation action and returns to the target's page in admin-web's Support section", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response({ id: "rca_1", recordedAt: acknowledgedAt }));
    vi.stubGlobal("fetch", fetch);
    const result = await action({
      request: new Request("https://admin.example.test/support/reported-content/listing/lst%2F1", {
        method: "POST",
        body: new URLSearchParams({ action: "dismiss", note: "Duplicate report" }),
      }),
      params: { targetType: "listing", targetId: "lst/1" },
      context: undefined,
    } as never);
    expect(result.status).toBe(302);
    expect(result.headers.get("Location")).toBe("/support/reported-content/listing/lst%2F1");
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toMatch(/\/reported-content\/listing\/lst%2F1\/actions$/);
    expect(JSON.parse(String(init?.body))).toEqual({ action: "dismiss", note: "Duplicate report" });
  });

  it("does not redirect or submit a disposition when acknowledgement is rejected", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      response({ error: { code: "validation_failed", reason: "target-disposed" } }, 400),
    );
    vi.stubGlobal("fetch", fetch);
    await expect(
      action({
        request: acknowledgeRequest(),
        params: { targetType: "listing", targetId: "lst_1" },
        context: undefined,
      } as never),
    ).rejects.toMatchObject({ status: 400 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
