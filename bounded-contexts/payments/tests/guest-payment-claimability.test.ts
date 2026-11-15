import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachResponseMetadata,
  getMutationResultCommandReceipt,
  getResponseMetadata,
} from "@chase-sets/http/responses";
import type { PaymentsPaymentDetail } from "../client";
import { PaymentsApiError, PaymentsApiResponseError } from "../client";
const { getAccountPayment, createClient } = vi.hoisted(() => ({ getAccountPayment: vi.fn(), createClient: vi.fn() }));
vi.mock("../support/request-support/api-client", () => ({ createPaymentsRequestApiClient: createClient }));
import { readGuestPaymentClaimability } from "../support/request-support/guest-payment-claimability";

describe("guest payment claimability", () => {
  afterEach(() => vi.resetAllMocks());
  it.each(["captured", "pending-confirmation", "failed", "cancelled"])(
    "uses the existing captured rule for %s and preserves metadata",
    async (status) => {
      const payment = attachResponseMetadata({ status } as PaymentsPaymentDetail, {
        headers: new Headers({ "Chase-Sets-Consistency": "eventual", "Chase-Sets-Commit-Position": "42" }),
      });
      getAccountPayment.mockResolvedValue(payment);
      createClient.mockReturnValue({ getAccountPayment });
      const request = new Request("https://marketplace.test/checkout/claim/pay_1", {
        headers: { authorization: "Bearer caller", cookie: "guest=caller" },
      });
      const result = await readGuestPaymentClaimability(request, "pay_1");
      expect(createClient).toHaveBeenCalledWith(request);
      expect(getAccountPayment).toHaveBeenCalledExactlyOnceWith("pay_1");
      expect(result).toEqual({ claimable: status === "captured" });
      expect(Object.keys(result)).toEqual(["claimable"]);
      expect(getResponseMetadata(result)).toEqual(getResponseMetadata(payment));
      expect(getMutationResultCommandReceipt(result)).toEqual(getMutationResultCommandReceipt(payment));
    },
  );
  it.each([401, 403, 404, 503, 500])("propagates status %s, body and message without coercion", async (status) => {
    const failure = new PaymentsApiError(status, {
      error: { code: "projection_freshness_timeout", message: "original failure" },
    });
    getAccountPayment.mockRejectedValue(failure);
    createClient.mockReturnValue({ getAccountPayment });
    await expect(readGuestPaymentClaimability(new Request("https://marketplace.test"), "pay_1")).rejects.toBe(failure);
  });
  it("does not turn malformed-success rejection into false", async () => {
    const failure = new PaymentsApiResponseError([{ path: ["status"], code: "invalid_type" }]);
    getAccountPayment.mockRejectedValue(failure);
    createClient.mockReturnValue({ getAccountPayment });
    await expect(readGuestPaymentClaimability(new Request("https://marketplace.test"), "pay_1")).rejects.toBe(failure);
  });
});
