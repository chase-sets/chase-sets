import { beforeEach, describe, expect, it, vi } from "vitest";
const { consume, resolveActor } = vi.hoisted(() => ({ consume: vi.fn(), resolveActor: vi.fn() }));
vi.mock("../support/request-support/api-client", () => ({
  createInternalAuthRequestApiClient: () => ({ claimGuestCheckoutWithClaimContinuation: consume }),
}));
vi.mock("@chase-sets/platform-runtime/auth", () => ({ resolveActorFromAuthApi: resolveActor }));
import { createGuestPaymentClaimRoute } from "../support/route-support/guest-payment-claim/route";

describe("guest claim browser authentication", () => {
  beforeEach(() => vi.resetAllMocks());
  it.each(["session-started", "account-selection-required"])(
    "consumes continuation before actor/payment reads and preserves %s cookies and return",
    async (type) => {
      const eligibility = vi.fn(async () => {
        throw new Error("Continuations must not read payment access.");
      });
      consume.mockResolvedValue(
        type === "session-started"
          ? {
              type,
              sessionToken: "session_token",
              session: { expires_at: "2099-01-01T00:00:00.000Z" },
            }
          : { type, selectionToken: "selection_token", selectionExpiresAt: "2099-01-01T00:00:00.000Z" },
      );
      const { loader } = createGuestPaymentClaimRoute(eligibility);
      const result = await loader({
        request: new Request("https://marketplace.test/checkout/claim/pay_1?claimContinuation=issued", {
          headers: { cookie: "chase_sets_guest_checkout=guest_token" },
        }),
        params: { paymentId: "pay_1" },
        context: undefined,
      }).catch((error: unknown) => {
        if (error instanceof Response) return error;
        throw error;
      });
      if (!(result instanceof Response)) throw new Error("Expected browser authentication redirect.");
      expect(result.status).toBe(302);
      expect(result.headers.get("location")).toBe(
        type === "session-started"
          ? "/account/payments/pay_1"
          : "/account/select?returnTo=%2Faccount%2Fpayments%2Fpay_1",
      );
      const cookies = result.headers.getSetCookie();
      expect(cookies.find((cookie) => cookie.startsWith("chase_sets_guest_checkout="))).toContain("Max-Age=0");
      const authenticatedCookie =
        type === "session-started"
          ? "chase_sets_session=session_token;"
          : "chase_sets_account_selection=selection_token;";
      expect(cookies.some((cookie) => cookie.startsWith(authenticatedCookie))).toBe(true);
      expect(consume).toHaveBeenCalledExactlyOnceWith({ continuation: "issued", paymentId: "pay_1" });
      expect(resolveActor).not.toHaveBeenCalled();
      expect(eligibility).not.toHaveBeenCalled();
    },
  );
});
