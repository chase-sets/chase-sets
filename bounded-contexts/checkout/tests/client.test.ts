import { afterEach, describe, expect, it, vi } from "vitest";
import { CheckoutApiError, createCheckoutApiClient } from "../client";

function hangingFetch() {
  return vi.fn(
    (_input: Parameters<typeof globalThis.fetch>[0], _init?: Parameters<typeof globalThis.fetch>[1]) =>
      new Promise<Response>(() => {}),
  ) as unknown as typeof globalThis.fetch;
}

describe("checkout API client", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("maps request timeouts to gateway timeout API errors when recovery is enabled", async () => {
    vi.useFakeTimers();
    const fetch = hangingFetch();
    const client = createCheckoutApiClient({
      baseUrl: "https://checkout.example.test/api/marketplace",
      fetch,
      requestTimeoutMs: 5,
      recoverTransportErrorsAsGatewayTimeout: true,
    });

    const read = client.getCheckoutSession("chk_timeout");
    const assertion = expect(read).rejects.toMatchObject({
      status: 504,
      body: null,
    } satisfies Partial<CheckoutApiError>);
    await vi.advanceTimersByTimeAsync(5);

    await assertion;
  });

  it("maps transport errors to gateway timeout API errors when recovery is enabled", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;
    const client = createCheckoutApiClient({
      baseUrl: "https://checkout.example.test/api/marketplace",
      fetch,
      recoverTransportErrorsAsGatewayTimeout: true,
    });

    await expect(client.getCheckoutSession("chk_transport")).rejects.toMatchObject({
      status: 504,
      body: null,
    } satisfies Partial<CheckoutApiError>);
  });

  it("preserves transport errors when gateway recovery is not enabled", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;
    const client = createCheckoutApiClient({
      baseUrl: "https://checkout.example.test/api/marketplace",
      fetch,
    });

    await expect(client.getCheckoutSession("chk_transport")).rejects.toThrow("fetch failed");
  });
});
