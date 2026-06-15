import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHASE_SETS_READ_AFTER_WRITE_HEADER,
  CHASE_SETS_READ_TARGET_CONTEXT_HEADER,
  appendFreshWriteToken,
  decodeFreshWriteReceipt,
} from "@chase-sets/http/responses";
import { createCheckoutRequestApiClient } from "./api-client";

const checkoutSource = {
  sourceContextName: "checkout",
  maxGlobalPosition: "42",
  eventIds: ["evt_checkout"],
};

describe("checkout request API client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("forwards fresh-read receipts and target context on Checkout API reads", async () => {
    const request = new Request(
      `http://localhost${appendFreshWriteToken(
        "/account/cart",
        { commitPositions: [checkoutSource], commitEventIds: ["evt_checkout"] },
        Date.now(),
      )}`,
      {
        headers: {
          cookie: "session=session_1",
        },
      },
    );
    let receivedInit: RequestInit | undefined;
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      receivedInit = init;
      return new Response(JSON.stringify({ items: [], count: 0 }), {
        headers: { "Content-Type": "application/json" },
      });
    });

    await createCheckoutRequestApiClient(request).getCart();

    const headers = new Headers(receivedInit?.headers);
    expect(headers.get("cookie")).toBe("session=session_1");
    expect(decodeFreshWriteReceipt(headers.get(CHASE_SETS_READ_AFTER_WRITE_HEADER))).toMatchObject({
      sources: [checkoutSource],
    });
    expect(headers.get(CHASE_SETS_READ_TARGET_CONTEXT_HEADER)).toBe("checkout");
  });
});
