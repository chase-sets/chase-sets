// jsdom does not implement ResizeObserver. MarketplaceProductMobileActionDock
// (packages/design-system/src/patterns/app-shells/product-detail.tsx) uses it to
// publish the dock's own measured height (#5963 decision 2); every item-detail test
// that mounts ItemDetailPage exercises that effect, so this stub keeps them running
// in jsdom without asserting anything about real browser resize behavior.
if (typeof globalThis.ResizeObserver === "undefined") {
  class NoopResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  (globalThis as typeof globalThis & { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
    NoopResizeObserver as unknown as typeof ResizeObserver;
}
