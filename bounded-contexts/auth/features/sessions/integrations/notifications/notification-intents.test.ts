import { describe, expect, it } from "vitest";
import {
  mapGuestCheckoutClaimLinkRequestedToNotification,
  mapPhoneCodeRequestedToNotification,
} from "./notification-intents";

describe("auth notification intents", () => {
  it("maps phone code requests to SMS notifications", () => {
    const message = mapPhoneCodeRequestedToNotification({
      phone: "+15555550123",
      code: "123456",
      correlationId: "req_phone",
      idempotencyKey: "auth:phone-code:cmd_1",
    });

    expect(message.messageType).toBe("auth.phone-code.requested");
    expect(message.channels[0]).toMatchObject({
      channel: "sms",
      to: { e164: "+15555550123" },
    });
    expect(message.templateData.code).toBe("123456");
  });

  it("maps guest checkout claim links to transactional email notifications", () => {
    const message = mapGuestCheckoutClaimLinkRequestedToNotification({
      email: "buyer@example.com",
      claimLink: "https://chasesets.com/checkout/payments/pay_1?claimContinuation=cont_1",
      correlationId: "req_claim",
      idempotencyKey: "auth:guest-checkout-claim-link:cmd_1",
    });

    expect(message.messageType).toBe("auth.guest-checkout-claim-link.requested");
    expect(message.channels[0]).toMatchObject({
      channel: "email",
      to: [{ email: "buyer@example.com" }],
      subject: "Save your Chase Sets order",
    });
    expect(message.templateData.claimLink).toBe(
      "https://chasesets.com/checkout/payments/pay_1?claimContinuation=cont_1",
    );
  });
});
