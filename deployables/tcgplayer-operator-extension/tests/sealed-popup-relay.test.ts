import { afterEach, describe, expect, it, vi } from "vitest";
import { installOperatorBridge } from "@chase-sets/catalog/client";
import { createSealedPopupClient } from "../../../bounded-contexts/catalog/features/operator-session/domain/extension/sealed-products/bridge";
import { runSealedProducts } from "../../../bounded-contexts/catalog/features/operator-session/domain/extension/sealed-products/run";
import {
  counts,
  detail,
  page,
  selection,
} from "../../../bounded-contexts/catalog/features/operator-session/tests/extension/sealed-products/fixture";

const id = "synthetic";
const origin = `chrome-extension://${id}`;
const search = "https://mp-search-api.tcgplayer.com/v1/search/request";
const details = "https://mp-search-api.tcgplayer.com/v2/product/1/details";
const catalog =
  "https://admin.staging.chasesets.com/api/public/catalog/operator-session/catalog-observations/tcgplayer-sealed-products";

async function startRelay(
  fetcher: typeof fetch,
  sender: chrome.runtime.MessageSender = { id, url: `${origin}/popup.html`, origin },
) {
  type Listener = (message: unknown, sender: chrome.runtime.MessageSender, reply: (value: unknown) => void) => boolean;
  let listener: Listener | undefined;
  const stored = new Map<string, unknown>();
  const runtime = {
    id,
    onMessage: { addListener: (fn: Listener) => (listener = fn) },
    onMessageExternal: { addListener: vi.fn() },
    sendMessage: vi.fn(
      (message: unknown) =>
        new Promise<unknown>((resolve, reject) => {
          const retained = listener?.(JSON.parse(JSON.stringify(message)), sender, (result) =>
            resolve(JSON.parse(JSON.stringify(result))),
          );
          if (!retained) reject(new Error("Synthetic message channel closed"));
        }),
    ),
  };
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("chrome", {
    runtime,
    action: { setBadgeText: async () => undefined },
    storage: {
      local: {
        setAccessLevel: async () => undefined,
        get: async (key: string) => ({ [key]: stored.get(key) }),
        set: async (value: Record<string, unknown>) => {
          for (const [key, entry] of Object.entries(value)) stored.set(key, entry);
        },
      },
    },
  });
  vi.resetModules();
  await import("../src/background");
  await runtime.sendMessage({ action: "pair", environment: "staging", grant: "A".repeat(43) });

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
  const dispose = installOperatorBridge(popup, { contentWindow: sandbox } as HTMLIFrameElement, runtime.sendMessage);
  const client = createSealedPopupClient(sandbox, origin);
  return {
    client,
    runtime,
    dispose() {
      client.dispose();
      dispose();
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("sealed operator relay", () => {
  it("fetches the first search page and detail and posts the reduced result through the installed worker listener", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      if (url === search) return Response.json(page(0, 1));
      if (url === details) return Response.json({ ...detail(), productId: 1 });
      if (url === catalog) return Response.json(counts);
      throw new Error("Unrouted synthetic request");
    });
    const relay = await startRelay(fetcher);
    try {
      const run = runSealedProducts({ ...relay.client, selection: selection(), environment: "staging" });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await run).toMatchObject({ outcome: "recorded", receipt: { posts: 1 } });
      expect(fetcher.mock.calls.map(([url]) => url)).toEqual([search, details, catalog]);
    } finally {
      relay.dispose();
    }
  });

  it("records only a fixed code on an endpoint network failure and never posts to Catalog", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("private diagnostic"));
    const relay = await startRelay(fetcher);
    try {
      const run = await runSealedProducts({ ...relay.client, selection: selection(), environment: "staging" });
      expect(run).toMatchObject({
        outcome: "unqualified",
        receipt: { pages: 0, posts: 0, requests: [{ status: null, code: "network-error" }] },
      });
      expect(JSON.stringify(run.receipt)).not.toMatch(/private diagnostic|https:|Bearer/i);
      expect(fetcher).toHaveBeenCalledExactlyOnceWith(search, expect.anything());
    } finally {
      relay.dispose();
    }
  });

  it("records a sender refusal without making a fetch", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const relay = await startRelay(fetcher, { id, url: `${origin}/popup.html`, origin: "null" });
    try {
      const run = await runSealedProducts({ ...relay.client, selection: selection(), environment: "staging" });
      expect(run.receipt.requests).toEqual([
        { endpoint: "search", status: null, contentClass: "unknown", bytes: 0, code: "refused" },
      ]);
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      relay.dispose();
    }
  });

  it("distinguishes the bridge deadline from a rejected runtime message", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fetcher = vi.fn<typeof fetch>();
    const relay = await startRelay(fetcher);
    try {
      relay.runtime.sendMessage.mockRejectedValueOnce(new Error("private diagnostic"));
      const request = { endpoint: "detail", productId: 1 } as const;
      expect(await relay.client.request(request)).toMatchObject({ code: "unavailable", body: null });
      relay.runtime.sendMessage.mockImplementationOnce(() => new Promise(() => {}));
      const timedOut = relay.client.request(request);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await timedOut).toMatchObject({ code: "timeout", body: null });
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      relay.dispose();
    }
  });
});
