import { describe, expect, it, vi } from "vitest";
import { createOperatorTransport } from "../../../domain/extension/transport";
import { createOperatorBackground } from "../../../domain/extension/background";
import { isSealedPostMessage, isSealedPostResult } from "../../../domain/extension/sealed-products/transport";
import { isSealedRequestMessage } from "../../../domain/extension/sealed-products/bridge";
import { createSealedPopupClient } from "../../../domain/extension/sealed-products/bridge";
import { installOperatorBridge } from "../../../domain/extension/bridge";
import { sealedPost } from "../../sealed-product-observation-fixture";
import { counts } from "./fixture";
const grant = "A".repeat(43);
describe("sealed products grant transport", () => {
  it("uses only the existing public Catalog route with the grant bearer and reduced post", async () => {
    const fetcher = vi.fn(async () => Response.json(counts));
    expect(await createOperatorTransport(fetcher).postSealedProducts("staging", grant, sealedPost())).toEqual({
      outcome: "recorded",
      ...counts,
    });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      "https://admin.staging.chasesets.com/api/public/catalog/operator-session/catalog-observations/tcgplayer-sealed-products",
      {
        method: "POST",
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        headers: { Authorization: `Bearer ${grant}`, "Content-Type": "application/json" },
        body: JSON.stringify(sealedPost()),
      },
    );
  });
  it.each([401, 403])("stops and clears the retained grant on %s", async (status) => {
    const fetcher = vi.fn(async () => new Response(null, { status }));
    const write = vi.fn(async () => undefined);
    const background = createOperatorBackground({
      storage: { trust: async () => undefined, read: async () => undefined, write },
      badge: async () => undefined,
      fetch: fetcher,
    });
    const sender = {
      id: "synthetic",
      url: "chrome-extension://synthetic/popup.html",
      origin: "chrome-extension://synthetic",
      hasTab: false,
    };
    await background.receive({ action: "pair", environment: "staging", grant }, sender, "synthetic");
    const message = { action: "post-sealed-products", environment: "staging", post: sealedPost() };
    expect(await background.receiveSealedProducts(message, sender, "synthetic")).toEqual({ outcome: "grant-invalid" });
    expect(await background.receiveSealedProducts(message, sender, "synthetic")).toEqual({ outcome: "grant-invalid" });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(write.mock.calls.at(-1)).toBeDefined();
    expect(await background.receive({ action: "status", environment: "staging" }, sender, "synthetic")).toMatchObject({
      paired: false,
      state: "re-pair-required",
    });
  });
  it.each([
    { ...counts, recorded: "1" },
    { ...counts, changed: -1 },
    { ...counts, unchanged: null },
    { ...counts, candidateCount: 0.5 },
    { ...counts, exclusions: [{ productId: 1, code: 3 }] },
    { ...counts, private: true },
    { ...counts, outcome: "recorded" },
  ])("rejects response field bypass mutant %j", async (body) => {
    expect(
      await createOperatorTransport(async () => Response.json(body)).postSealedProducts("staging", grant, sealedPost()),
    ).toEqual({ outcome: "invalid-response" });
  });
  it("refuses invalid grants and unparsed posts without sending", async () => {
    const fetcher = vi.fn();
    const transport = createOperatorTransport(fetcher);
    expect(await transport.postSealedProducts("staging", "invalid", sealedPost())).toEqual({ outcome: "refused" });
    const post = sealedPost();
    Object.assign(post.products[0]!, { marketPrice: 1 });
    expect(await transport.postSealedProducts("staging", grant, post)).toEqual({ outcome: "refused" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(isSealedPostMessage({ action: "post-sealed-products", environment: "staging", post, extra: true })).toBe(
      false,
    );
    expect(isSealedPostResult({ outcome: "recorded" })).toBe(false);
    expect(
      isSealedRequestMessage({
        action: "fetch-sealed-products",
        request: { endpoint: "detail", productId: 1, url: "private" },
      }),
    ).toBe(false);
  });
  it.each([{ id: "other" }, { url: "chrome-extension://synthetic/other.html" }, { origin: "null" }, { hasTab: true }])(
    "rejects each sender guard bypass mutant %j",
    async (mutation) => {
      const request = vi.fn();
      const fetcher = vi.fn();
      const background = createOperatorBackground({
        storage: { trust: async () => undefined, read: async () => undefined, write: async () => undefined },
        badge: async () => undefined,
        fetch: fetcher,
        sealedProducts: request,
      });
      const sender = {
        id: "synthetic",
        url: "chrome-extension://synthetic/popup.html",
        origin: "chrome-extension://synthetic",
        hasTab: false,
        ...mutation,
      };
      expect(
        await background.receiveSealedProducts(
          { action: "fetch-sealed-products", request: { endpoint: "detail", productId: 1 } },
          sender,
          "synthetic",
        ),
      ).toBeNull();
      expect(
        await background.receiveSealedProducts(
          { action: "post-sealed-products", environment: "staging", post: sealedPost() },
          sender,
          "synthetic",
        ),
      ).toBeNull();
      expect(request).not.toHaveBeenCalled();
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it("composes the sandbox client, trusted bridge, background, endpoint adapter and grant transport", async () => {
    type Handler = (event: MessageEvent<unknown>) => void;
    const popupListeners = new Set<Handler>();
    const frameListeners = new Set<Handler>();
    const origin = "chrome-extension://synthetic";
    const popup = {
      addEventListener: (_type: string, handler: Handler) => popupListeners.add(handler),
      removeEventListener: (_type: string, handler: Handler) => popupListeners.delete(handler),
      postMessage(data: unknown) {
        for (const handler of popupListeners) handler({ data, source: frame, origin: "null" } as MessageEvent);
      },
    } as unknown as Window;
    const frame = {
      parent: popup,
      addEventListener: (_type: string, handler: Handler) => frameListeners.add(handler),
      removeEventListener: (_type: string, handler: Handler) => frameListeners.delete(handler),
      postMessage(data: unknown) {
        for (const handler of frameListeners) handler({ data, source: popup, origin } as MessageEvent);
      },
    } as unknown as Window;
    const fetcher = vi.fn(async () => Response.json(counts));
    const endpoint = vi.fn(async () => ({ ok: true, status: 200, contentClass: "json" as const, bytes: 2, body: {} }));
    const background = createOperatorBackground({
      storage: { trust: async () => undefined, read: async () => undefined, write: async () => undefined },
      badge: async () => undefined,
      fetch: fetcher,
      sealedProducts: endpoint,
    });
    const sender = { id: "synthetic", url: `${origin}/popup.html`, origin, hasTab: false };
    await background.receive({ action: "pair", environment: "staging", grant }, sender, "synthetic");
    const dispose = installOperatorBridge(popup, { contentWindow: frame } as HTMLIFrameElement, (value) =>
      background.receiveSealedProducts(value, sender, "synthetic"),
    );
    const client = createSealedPopupClient(frame, origin);
    try {
      expect(await client.request({ endpoint: "detail", productId: 1 })).toMatchObject({ ok: true });
      const pending = client.post("staging", sealedPost());
      for (const handler of frameListeners) {
        handler({
          source: popup,
          origin: "https://attacker.test",
          data: { sealedId: 2, result: { outcome: "refused" } },
        } as MessageEvent);
        handler({ source: {}, origin, data: { sealedId: 2, result: { outcome: "refused" } } } as MessageEvent);
      }
      expect(await pending).toEqual({ outcome: "recorded", ...counts });
      expect(endpoint).toHaveBeenCalledExactlyOnceWith({ endpoint: "detail", productId: 1 });
      expect(fetcher).toHaveBeenCalledOnce();
    } finally {
      client.dispose();
      dispose();
    }
    expect(popupListeners.size).toBe(0);
    expect(frameListeners.size).toBe(0);
  });
});
