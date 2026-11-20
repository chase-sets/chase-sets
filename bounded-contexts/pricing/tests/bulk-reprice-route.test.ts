import { afterEach, describe, expect, it, vi } from "vitest";
import { t } from "@chase-sets/localization";
import { action as bulkRepriceAction, loader as bulkRepriceLoader } from "../routes/marketplace/bulk-reprice";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const actor = {
  sessionId: "ses_1",
  tenantId: "tnt_identity",
  userId: "usr_1",
  accountId: "acc_1",
  membershipId: "mbr_1",
  roleKey: "owner",
  permissions: ["listings.manage"],
};

/** Pricing as marketplace reaches it, with bulk reprice on or off (its whole tree then answers 404). */
function stubPricing(enabled: boolean) {
  const calls: string[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = (input instanceof Request ? input.method : init?.method) ?? "GET";
    if (url.pathname.includes("/api/auth/session")) return jsonResponse({ actor });
    calls.push(`${method} ${url.pathname}`);
    if (!enabled) return jsonResponse({}, 404);
    if (url.pathname.endsWith("/account/bulk-reprice") && method === "GET") return jsonResponse({ enabled: true });
    return jsonResponse({ error: { code: "invalid_csv", message: "The CSV has no rows." } }, 400);
  });
  vi.stubGlobal("fetch", fetch);
  return calls;
}

function upload() {
  const body = new FormData();
  body.set("intent", "upload-bulk-reprice");
  body.set("csvText", "listingId,newPrice\nlst_1,12.00\n");
  return bulkRepriceAction({
    request: new Request("https://marketplace.test/account/bulk-reprice", { method: "POST", body }),
    params: {},
    context: undefined,
  } as never);
}

const page = (query = "") =>
  bulkRepriceLoader({
    request: new Request(`https://marketplace.test/account/bulk-reprice${query}`),
    params: {},
    context: undefined,
  } as never);

describe("marketplace bulk reprice route", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("says bulk reprice is not available (404) while Pricing has it off, and reads no job", async () => {
    const calls = stubPricing(false);

    const result = (await page("?jobId=job_1")) as unknown as {
      data: { available: boolean; activeJob: unknown };
      init: { status: number };
    };

    expect(result.init.status).toBe(404);
    expect(result.data).toEqual({ available: false, activeJobId: "", activeJob: null });
    expect(calls.some((call) => call.includes("/jobs/"))).toBe(false);
  });

  it("draws the page while Pricing has it on", async () => {
    stubPricing(true);

    await expect(page()).resolves.toEqual({ available: true, activeJobId: "", activeJob: null });
  });

  it("answers an upload refused because bulk reprice was switched off with that, not the API's 404", async () => {
    stubPricing(false);
    await expect(upload()).resolves.toEqual({
      error: t("pricing.features.bulkRepriceIngestion.ui.bulkRepricePage.unavailable"),
    });

    // Any other refusal keeps Pricing's words.
    stubPricing(true);
    await expect(upload()).resolves.toEqual({ error: expect.not.stringContaining("not available") });
  });
});
