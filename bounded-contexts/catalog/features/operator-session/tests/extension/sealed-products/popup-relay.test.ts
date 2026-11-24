import { afterEach, describe, expect, it, vi } from "vitest";
import { createOperatorBackground } from "../../../domain/extension/background";
import { installOperatorBridge } from "../../../domain/extension/bridge";
import { createSealedPopupClient } from "../../../domain/extension/sealed-products/bridge";
import type { SealedFetch } from "../../../domain/extension/sealed-products/collector";
import { runSealedProducts } from "../../../domain/extension/sealed-products/run";
import { counts, detail, page, response, selection } from "./fixture";

const id = "synthetic";
const origin = `chrome-extension://${id}`;
const popupSender = { id, url: `${origin}/popup.html`, origin, hasTab: false };
const search = { endpoint: "search", from: 0, includeProductLine: true } as const;
const catalog =
  "https://admin.staging.chasesets.com/api/public/catalog/operator-session/catalog-observations/tcgplayer-sealed-products";

async function startRelay(sealedProducts: SealedFetch, fetcher: typeof fetch, sender = popupSender) {
  const stored = new Map<string, unknown>();
  const background = createOperatorBackground({
    storage: {
      trust: async () => undefined,
      read: async (key) => stored.get(key),
      write: async (key, value) => {
        stored.set(key, value);
      },
    },
    badge: async () => undefined,
    fetch: fetcher,
    sealedProducts,
  });
  await background.receive({ action: "pair", environment: "staging", grant: "A".repeat(43) }, popupSender, id);
  const sendMessage = vi.fn(async (message: unknown) => {
    const result = await background.receiveSealedProducts(JSON.parse(JSON.stringify(message)), sender, id);
    return JSON.parse(JSON.stringify(result)) as unknown;
  });

  const popupEvents = new EventTarget();
  const sandboxEvents = new EventTarget();
  const post = (events: EventTarget, data: unknown, source: unknown, origin: string) =>
    queueMicrotask(() => {
      const event = new Event("message");
      Object.assign(event, { data: structuredClone(data), source, origin });
      events.dispatchEvent(event);
    });
  const popup = Object.assign(popupEvents, {
    postMessage(data: unknown) {
      post(popupEvents, data, sandbox, "null");
    },
  }) as unknown as Window;
  const sandbox = Object.assign(sandboxEvents, {
    parent: popup,
    postMessage(data: unknown) {
      post(sandboxEvents, data, popup, origin);
    },
  }) as unknown as Window;
  const dispose = installOperatorBridge(popup, { contentWindow: sandbox } as HTMLIFrameElement, sendMessage);
  const client = createSealedPopupClient(sandbox, origin);
  return {
    client,
    sendMessage,
    dispose() {
      client.dispose();
      dispose();
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("sealed operator relay", () => {
  it("fetches the first search page and detail and posts the reduced result through the background relay", async () => {
    const sealedProducts = vi.fn<SealedFetch>(async (request) =>
      response(request.endpoint === "search" ? page(0, 1) : { ...detail(), productId: 1 }),
    );
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(counts));
    const relay = await startRelay(sealedProducts, fetcher);
    try {
      const set = selection();
      const run = await runSealedProducts({ ...relay.client, selection: set, environment: "staging" });
      expect(run).toMatchObject({ outcome: "recorded", receipt: { posts: 1 } });
      expect(sealedProducts.mock.calls).toEqual([
        [{ ...search, productLineId: set.productLineId, setName: set.setName }],
        [{ endpoint: "detail", productId: 1 }],
      ]);
      expect(fetcher).toHaveBeenCalledExactlyOnceWith(catalog, expect.objectContaining({ method: "POST" }));
      expect(sealedProducts.mock.invocationCallOrder[1]!).toBeLessThan(fetcher.mock.invocationCallOrder[0]!);
      expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toMatchObject({
        products: [{ productId: 1 }],
      });
    } finally {
      relay.dispose();
    }
  });

  it("records only a fixed code on an endpoint network failure and never posts to Catalog", async () => {
    const sealedProducts = vi.fn<SealedFetch>().mockResolvedValue({
      ok: false,
      status: null,
      contentClass: "unknown",
      bytes: 0,
      body: null,
      code: "network-error",
    });
    const fetcher = vi.fn<typeof fetch>();
    const relay = await startRelay(sealedProducts, fetcher);
    try {
      const set = selection();
      const run = await runSealedProducts({ ...relay.client, selection: set, environment: "staging" });
      expect(run).toMatchObject({
        outcome: "unqualified",
        receipt: { pages: 0, posts: 0, requests: [{ status: null, code: "network-error" }] },
      });
      expect(JSON.stringify(run.receipt)).not.toMatch(/private diagnostic|https:|Bearer/i);
      expect(sealedProducts).toHaveBeenCalledExactlyOnceWith({
        ...search,
        productLineId: set.productLineId,
        setName: set.setName,
      });
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      relay.dispose();
    }
  });

  it("records a sender refusal without making a fetch", async () => {
    const sealedProducts = vi.fn<SealedFetch>();
    const fetcher = vi.fn<typeof fetch>();
    const relay = await startRelay(sealedProducts, fetcher, { ...popupSender, origin: "null" });
    try {
      const run = await runSealedProducts({ ...relay.client, selection: selection(), environment: "staging" });
      expect(run.receipt.requests).toEqual([
        { endpoint: "search", status: null, contentClass: "unknown", bytes: 0, code: "refused" },
      ]);
      expect(sealedProducts).not.toHaveBeenCalled();
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      relay.dispose();
    }
  });

  it("distinguishes the bridge deadline from a rejected runtime message", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const sealedProducts = vi.fn<SealedFetch>();
    const fetcher = vi.fn<typeof fetch>();
    const relay = await startRelay(sealedProducts, fetcher);
    try {
      relay.sendMessage.mockRejectedValueOnce(new Error("private diagnostic"));
      const request = { endpoint: "detail", productId: 1 } as const;
      expect(await relay.client.request(request)).toMatchObject({ code: "unavailable", body: null });
      relay.sendMessage.mockImplementationOnce(() => new Promise(() => {}));
      const timedOut = relay.client.request(request);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await timedOut).toMatchObject({ code: "timeout", body: null });
      expect(sealedProducts).not.toHaveBeenCalled();
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      relay.dispose();
    }
  });
});
