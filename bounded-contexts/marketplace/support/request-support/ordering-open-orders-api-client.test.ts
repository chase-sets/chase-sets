import { afterEach, describe, expect, it, vi } from "vitest";
import orderingContext from "../../../ordering/context.json";
import {
  createOrderingOpenOrdersApiClient,
  createOrderingOpenOrdersRequestApiClient,
} from "./ordering-open-orders-api-client";

const mountPath = orderingContext.apiMounts.find((mount) => mount.kind === "primary")!.mountPath;
const orderCapacityPath = `${mountPath}/account/sales/order-capacity`;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Ordering open orders API client mount contract", () => {
  it("requests the mounted own-account route from the default factory", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ open_order_count: 2 }));

    expect(await createOrderingOpenOrdersApiClient({ fetch }).getSellerOpenOrderCount()).toBe(2);
    expect(fetch).toHaveBeenCalledWith(
      orderCapacityPath,
      expect.objectContaining({ method: "GET", credentials: "include" }),
    );
  });

  it("requests the mounted own-account route from the request-scoped factory", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ open_order_count: 2 }));
    vi.stubGlobal("fetch", fetch);
    const request = new Request("https://example.test/account/desk", { headers: { cookie: "session=synthetic" } });

    expect(await createOrderingOpenOrdersRequestApiClient(request).getSellerOpenOrderCount()).toBe(2);
    expect(fetch).toHaveBeenCalledWith(
      `https://example.test${orderCapacityPath}`,
      expect.objectContaining({ method: "GET", credentials: "include", headers: expect.any(Headers) }),
    );
    expect(new Headers(fetch.mock.calls[0]![1]?.headers).get("cookie")).toBe("session=synthetic");
  });
});
