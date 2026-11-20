import { describe, expect, it, vi } from "vitest";
import { readSetupLists, readEbaySetupJson, type SetupRead } from "../api/setup-listing";
import { materialFingerprint, parsePolicyItem, parseLocationItem } from "../domain/setup-material";
import { choice, location, policy, setupRead } from "./setup-fixtures";
import { ebaySellerSetupSelectedCodec, parseSetupCommand, parseSetupSelection } from "../domain/setup-selection";
import { decideChannelConnection, initialChannelConnectionState } from "../../connections/domain/domain";
import { readEbayProviderJson } from "../api/provider";

describe("ebay-sandbox-setup-listing", () => {
  it("bounds streamed setup and OAuth response bytes and refuses malformed or failed responses", async () => {
    await expect(readEbayProviderJson(new Response("{"))).rejects.toMatchObject({ code: "invalid-provider-response" });
    await expect(readEbayProviderJson(new Response("synthetic-provider-error", { status: 500 }))).rejects.toMatchObject(
      { code: "provider-unavailable" },
    );
    await expect(readEbayProviderJson(new Response(" ".repeat(65537)))).rejects.toMatchObject({
      code: "invalid-provider-response",
    });
    await expect(readEbayProviderJson(new Response(" ".repeat(1048577)), 1048576)).rejects.toMatchObject({
      code: "invalid-provider-response",
    });
  });
  it("accepts complete and empty captured lists without inventing a choice", async () => {
    const result = await readSetupLists("synthetic-token", setupRead);
    expect(Object.values(result).every((list) => list.status === "complete" && list.items.length === 1)).toBe(true);
    const empty: SetupRead = async (url) =>
      url.includes("/location")
        ? { total: 0, limit: 100, locations: [] }
        : { total: 0, [`${url.split("/").at(-1)!.split("_")[0]}Policies`]: [] };
    expect(
      Object.values(await readSetupLists("synthetic-token", empty)).every(
        (list) => list.status === "complete" && list.items.length === 0,
      ),
    ).toBe(true);
  });
  it.each(["count", "failure", "unknown-field", "nested-field", "nested-type", "duplicate", "wrong-marketplace"])(
    "blocks %s policies with no selectable partial items",
    async (defect) => {
      const read: SetupRead = async (url, token, signal) => {
        if (!url.includes("fulfillment_policy")) return setupRead(url, token, signal);
        if (defect === "failure") throw new Error("synthetic-provider-error");
        const item = policy("fulfillment");
        return {
          total: defect === "count" || defect === "duplicate" ? 2 : 1,
          fulfillmentPolicies:
            defect === "duplicate"
              ? [item, item]
              : [
                  {
                    ...item,
                    ...(defect === "unknown-field" ? { surprise: true } : {}),
                    ...(defect === "nested-field" ? { handlingTime: { value: 1, unit: "DAY", ignored: true } } : {}),
                    ...(defect === "nested-type"
                      ? { shippingOptions: [{ shippingServices: [{ shippingCost: { value: 5, currency: "USD" } }] }] }
                      : {}),
                    ...(defect === "wrong-marketplace" ? { marketplaceId: "EBAY_GB" } : {}),
                  },
                ],
        };
      };
      expect((await readSetupLists("synthetic-token", read)).fulfillment).toEqual({ status: "incomplete", items: [] });
    },
  );
  const page = (offset: number, total = 200) => ({
    total,
    limit: 100,
    offset,
    locations: Array.from({ length: Math.min(100, total - offset) }, (_, i) => location(`location-${offset + i}`)),
    ...(offset + 100 < total
      ? { next: `https://api.sandbox.ebay.com/sell/inventory/v1/location?offset=${offset + 100}&limit=100` }
      : {}),
  });
  it("sends en-US language headers on every Inventory location page", async () => {
    const transport = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      return Response.json(
        url.includes("/location")
          ? page(Number(new URL(url).searchParams.get("offset")))
          : await setupRead(url, "synthetic-token", AbortSignal.timeout(1000)),
      );
    });
    vi.stubGlobal("fetch", transport);
    try {
      expect((await readSetupLists("synthetic-token")).locations.items).toHaveLength(200);
      const reads = transport.mock.calls.filter(([url]) => String(url).includes("/location"));
      expect(reads.map(([url]) => String(url))).toEqual([
        "https://api.sandbox.ebay.com/sell/inventory/v1/location?offset=0&limit=100",
        "https://api.sandbox.ebay.com/sell/inventory/v1/location?offset=100&limit=100",
      ]);
      for (const [, options] of reads) {
        const headers = new Headers(options?.headers);
        expect(headers.get("authorization")).toBe("Bearer synthetic-token");
        expect(headers.get("Accept-Language")).toBe("en-US");
        expect(headers.get("Content-Language")).toBe("en-US");
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("reconciles all location pages and rejects a same-key duplicate", async () => {
    const read: SetupRead = async (url, token, signal) =>
      url.includes("/location") ? page(Number(new URL(url).searchParams.get("offset"))) : setupRead(url, token, signal);
    expect((await readSetupLists("synthetic-token", read)).locations.items).toHaveLength(200);
    const duplicate: SetupRead = async (url, token, signal) =>
      url.includes("offset=100") ? { ...page(100), locations: page(0).locations } : read(url, token, signal);
    expect((await readSetupLists("synthetic-token", duplicate)).locations).toEqual({ status: "incomplete", items: [] });
  });
  it.each([
    "https://evil.example/location?offset=100&limit=100",
    "https://api.sandbox.ebay.com/other?offset=100&limit=100",
    "https://user@api.sandbox.ebay.com/sell/inventory/v1/location?offset=100&limit=100",
    "https://api.sandbox.ebay.com/sell/inventory/v1/location?offset=0&limit=100",
    "https://api.sandbox.ebay.com/sell/inventory/v1/location?offset=100&limit=100&limit=100",
  ])("never follows unsafe next %s", async (next) => {
    const read = vi.fn<SetupRead>(async (url, token, signal) =>
      url.includes("/location") ? { ...page(0), next } : setupRead(url, token, signal),
    );
    expect((await readSetupLists("synthetic-token", read)).locations.status).toBe("incomplete");
    expect(read).toHaveBeenCalledTimes(4);
  });
  it.each(["count", "changed-total", "offset", "empty-next", "unsafe-href", "failure"])(
    "blocks %s location reads",
    async (defect) => {
      const read: SetupRead = async (url, token, signal) => {
        if (!url.includes("/location")) return setupRead(url, token, signal);
        if (defect === "failure") throw new Error("synthetic-error");
        const offset = Number(new URL(url).searchParams.get("offset"));
        return {
          ...page(offset),
          ...(defect === "count" ? { next: undefined, total: 101 } : {}),
          ...(defect === "changed-total" && offset ? { total: 201 } : {}),
          ...(defect === "offset" ? { offset: 1 } : {}),
          ...(defect === "empty-next" ? { locations: [] } : {}),
          ...(defect === "unsafe-href" ? { href: "https://evil.example/" } : {}),
        };
      };
      expect((await readSetupLists("synthetic-token", read)).locations).toEqual({ status: "incomplete", items: [] });
    },
  );
  it("accepts exactly 50 complete pages but refuses cap+1 without fetching it", async () => {
    for (const total of [5000, 5001]) {
      const read = vi.fn<SetupRead>(async (url, token, signal) =>
        url.includes("/location")
          ? page(Number(new URL(url).searchParams.get("offset")), total)
          : setupRead(url, token, signal),
      );
      const result = (await readSetupLists("synthetic-token", read)).locations;
      expect(result.status).toBe(total === 5000 ? "complete" : "incomplete");
      expect(result.items).toHaveLength(total === 5000 ? 5000 : 0);
      expect(read).toHaveBeenCalledTimes(53);
    }
  });
  it("uses bounded no-redirect bearer reads and never leaks raw errors", async () => {
    const transport = vi.fn<typeof fetch>(async () => Response.json({ total: 0 }));
    vi.stubGlobal("fetch", transport);
    try {
      await expect(
        readEbaySetupJson("https://api.sandbox.ebay.com/example", "synthetic-token", AbortSignal.timeout(1000)),
      ).resolves.toEqual({ total: 0 });
      expect(transport.mock.calls[0]?.[1]).toMatchObject({
        redirect: "error",
        cache: "no-store",
        headers: { authorization: "Bearer synthetic-token" },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("selection-time material baseline and closed command", () => {
  it("hashes parsed material, not paging, retaining every admitted field and array order", async () => {
    const item = parsePolicyItem("fulfillment", policy("fulfillment"));
    const reordered = Object.fromEntries(Object.entries(item).reverse());
    expect(materialFingerprint(item)).toBe(materialFingerprint(reordered));
    expect(materialFingerprint(item)).not.toBe(
      materialFingerprint(parsePolicyItem("fulfillment", { ...policy("fulfillment"), name: "changed" })),
    );
    expect(materialFingerprint(parseLocationItem(location()))).not.toBe(
      materialFingerprint(parseLocationItem({ ...location(), locationInstructions: "Use side door" })),
    );
    const first = await readSetupLists("synthetic-token", setupRead);
    const second = await readSetupLists("synthetic-token", async (url, token, signal) =>
      url.includes("/location")
        ? { total: 1, limit: 100, href: url, offset: 0, locations: [location()] }
        : setupRead(url, token, signal),
    );
    expect(materialFingerprint(first.locations.items[0])).toBe(materialFingerprint(second.locations.items[0]));
    expect(materialFingerprint({ a: [1, 2] })).not.toBe(materialFingerprint({ a: [2, 1] }));
  });
  it.each([
    {},
    { ...choice(), extra: true },
    { ...choice(), expectedSetupGeneration: -1 },
    { ...choice(), policies: choice().policies.slice(1) },
    { ...choice(), locationPairs: [] },
    { ...choice(), locationPairs: [...choice().locationPairs, ...choice().locationPairs] },
  ])("rejects partial or forged selection %j", (value) => {
    expect(() => parseSetupCommand(value)).toThrow();
  });
  it("validates closed selected event payloads and material fingerprints", () => {
    const selection = {
      connectionId: "connection-1",
      setupGeneration: 1,
      policies: choice().policies.map((item) => ({ ...item, materialFingerprint: `v1:${"a".repeat(64)}` })),
      locationPairs: choice().locationPairs.map((item) => ({ ...item, materialFingerprint: `v1:${"b".repeat(64)}` })),
    };
    expect(parseSetupSelection(selection)).toEqual(selection);
    const encoded = ebaySellerSetupSelectedCodec.encode({
      type: "channels.ebay-seller-setup.selected",
      data: selection,
    });
    expect(ebaySellerSetupSelectedCodec.decode(encoded)).toEqual({
      type: "channels.ebay-seller-setup.selected",
      data: selection,
    });
    expect(() => ebaySellerSetupSelectedCodec.decode({ eventType: "channels.other", payload: selection })).toThrow();
    expect(() => parseSetupSelection({ ...selection, extra: true })).toThrow();
    expect(() =>
      parseSetupSelection({ ...selection, policies: [{ ...selection.policies[0], materialFingerprint: "guessed" }] }),
    ).toThrow();
  });
  it("allows active Sandbox eBay reselection without changing other lifecycle transitions", () => {
    const state = {
      ...initialChannelConnectionState,
      connectionId: "connection-1",
      providerKey: "ebay",
      environment: "sandbox" as const,
      status: "active" as const,
    };
    const command = {
      type: "ActivateChannelConnection" as const,
      credentialReference: "credential-1",
      bindings: [{ storageLocationId: "storage-1", revision: 1 }],
    };
    expect(decideChannelConnection(state, command)[0].type).toBe("channels.connection.activated");
    expect(() => decideChannelConnection({ ...state, providerKey: "tcgplayer" }, command)).toThrow();
    expect(() => decideChannelConnection({ ...state, environment: "production" }, command)).toThrow();
    expect(() => decideChannelConnection({ ...state, status: "paused" }, command)).toThrow();
    expect(() => decideChannelConnection({ ...state, status: "disconnected" }, command)).toThrow();
  });
});
