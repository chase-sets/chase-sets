import { afterEach, describe, expect, it } from "vitest";
import {
  readCompactPostWriteToken,
  readFreshWriteToken,
  readPostWriteHandoff,
  type PostWriteTokenPayload,
} from "@chase-sets/http/responses";
import {
  configurePlatformPostWriteTokenStoreForTests,
  navigateAfterWriteWithPlatformPostWriteToken,
  resolvePlatformPostWriteRequest,
} from "./post-write-tokens";

function createTestPostWriteTokenStore() {
  const payloads = new Map<string, PostWriteTokenPayload>();

  return {
    payloads,
    store: {
      async storePostWriteToken(payload: PostWriteTokenPayload) {
        const token = `pwt_route${String(payloads.size + 1).padStart(16, "0")}`;
        payloads.set(token, payload);
        return token;
      },
      async resolvePostWriteToken(token: string) {
        return payloads.get(token) ?? null;
      },
    },
  };
}

afterEach(() => {
  configurePlatformPostWriteTokenStoreForTests(null);
});

describe("platform post-write token route helpers", () => {
  it("binds compact navigation to the configured store without leaking receipt or handoff details", async () => {
    const { store } = createTestPostWriteTokenStore();
    configurePlatformPostWriteTokenStoreForTests(store);

    const href = await navigateAfterWriteWithPlatformPostWriteToken(
      {
        commitPositions: [{ sourceContextName: "checkout", maxGlobalPosition: "42", eventIds: ["evt_checkout"] }],
        commitEventIds: ["evt_checkout"],
      },
      "/account/cart?returnTo=%2Fcheckout%2Fbuy%2Fsession%2Fchk_1",
      {
        nowMs: 1_000,
        handoff: {
          kind: "checkout.cart.add-line",
          expectation: "collection-non-empty",
          surface: "account-cart",
        },
      },
    );

    expect(href.length).toBeLessThan(140);
    expect(href).toContain("postWriteToken=");
    expect(href).not.toContain("afterWrite=");
    expect(href).not.toContain("postWriteHandoff=");
    expect(href).not.toContain("evt_checkout");
    expect(href).not.toContain("checkout.cart.add-line");

    const resolvedRequest = await resolvePlatformPostWriteRequest(
      new Request(`https://marketplace.chasesets.test${href}`),
    );

    expect(readCompactPostWriteToken(resolvedRequest)).toBeNull();
    expect(readFreshWriteToken(resolvedRequest, 1_000)).toEqual({
      observedAtMs: 1_000,
      sources: [{ sourceContextName: "checkout", maxGlobalPosition: "42", eventIds: ["evt_checkout"] }],
    });
    expect(readPostWriteHandoff(resolvedRequest, 1_000)).toEqual({
      kind: "checkout.cart.add-line",
      expectation: "collection-non-empty",
      surface: "account-cart",
    });
  });
});
