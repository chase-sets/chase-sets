import { describe, expect, it } from "vitest";
import type { TransactionalEmailMessage } from "@chase-sets/outbound-messaging";
import { platformEmailTemplateRenderer } from "../src/email-template-renderer";

describe("platform email template renderer", () => {
  it("renders the waitlist confirmation as early access marketing copy", () => {
    const rendered = platformEmailTemplateRenderer.render(
      message({
        subject: "Welcome to Chase Sets early access",
        templateId: "waitlist_signup_confirmation",
        templateData: {
          headline: "You are on the early access list.",
          intro:
            "Thanks for requesting early access. Chase Sets is building a faster card marketplace for collectors who want sharper pricing, lower seller fees, and cleaner buying and selling workflows.",
          nextStep: "We will send launch updates and beta invites as access opens.",
        },
      }),
    );

    expect(rendered.subject).toBe("Welcome to Chase Sets early access");
    expect(rendered.textBody).toContain("You are on the early access list.");
    expect(rendered.textBody).toContain("lower seller fees");
    expect(rendered.textBody).toContain("launch updates and beta invites");
    expect(rendered.textBody).not.toContain("A Chase Sets account update is available.");
    expect(rendered.textBody).not.toContain("signupId:");
    expect(rendered.htmlBody).toContain("Card marketplace updates");
    expect(rendered.htmlBody).toContain("background:#f4f6f2");
    expect(rendered.htmlBody).toContain("Welcome to Chase Sets early access");
    expect(rendered.htmlBody).toContain("lower seller fees");
  });

  it("keeps the generic fallback for unknown operational templates", () => {
    const rendered = platformEmailTemplateRenderer.render(
      message({
        subject: "Account update",
        templateId: "unknown_template",
        templateData: { status: "updated" },
      }),
    );

    expect(rendered.textBody).toContain("A Chase Sets account update is available.");
    expect(rendered.textBody).toContain("status: updated");
  });

  it("renders guest checkout claim links as order-save email copy", () => {
    const rendered = platformEmailTemplateRenderer.render(
      message({
        subject: "Save your Chase Sets order",
        templateId: "auth_guest_checkout_claim_link",
        templateData: {
          claimLink: "https://chasesets.com/checkout/payments/pay_1?claimContinuation=cont_1",
        },
      }),
    );

    expect(rendered.subject).toBe("Save your Chase Sets order");
    expect(rendered.textBody).toContain("save your guest checkout order");
    expect(rendered.textBody).toContain("https://chasesets.com/checkout/payments/pay_1?claimContinuation=cont_1");
    expect(rendered.textBody).not.toContain("A Chase Sets account update is available.");
  });

  it("renders order confirmation copy with the support-safe order reference, never the raw ULID", () => {
    const rendered = platformEmailTemplateRenderer.render(
      message({
        subject: "Order ORD-E6K7M8N9 confirmed",
        templateId: "order_confirmed",
        templateData: { orderReference: "ORD-E6K7M8N9", orderTotal: "18.50" },
      }),
    );

    expect(rendered.textBody).toContain("Order reference: ORD-E6K7M8N9");
    expect(rendered.textBody).toContain("Order total: 18.50");
    expect(rendered.textBody).not.toContain("ord_01");
    expect(rendered.htmlBody).toContain("Order ORD-E6K7M8N9 confirmed");
  });

  it("renders payment-deadline cancellation copy with the order reference and a raw-id reorder link", () => {
    const rendered = platformEmailTemplateRenderer.render(
      message({
        subject: "Order ORD-E6K7M8N9 cancelled after payment deadline",
        templateId: "order_payment_deadline_cancelled",
        templateData: {
          orderReference: "ORD-E6K7M8N9",
          reorderHref: "/marketplace?reorderFrom=ord_01JZ6DKP7S7Z4AZ5N5E6K7M8N9",
        },
      }),
    );

    expect(rendered.textBody).toContain("Order reference: ORD-E6K7M8N9");
    expect(rendered.textBody).toContain("Reorder: /marketplace?reorderFrom=ord_01JZ6DKP7S7Z4AZ5N5E6K7M8N9");
  });

  it("renders payment captured copy with the borrowed order reference", () => {
    const rendered = platformEmailTemplateRenderer.render(
      message({
        subject: "Payment received for ORD-E6K7M8N9",
        templateId: "payment_captured",
        templateData: { paymentReference: "ORD-E6K7M8N9", amount: "20.00", currencyCode: "USD" },
      }),
    );

    expect(rendered.textBody).toContain("Payment reference: ORD-E6K7M8N9");
    expect(rendered.textBody).toContain("Amount: 20.00 USD");
  });

  it("renders shipment delivered copy with the support-safe order reference, never the raw ULID", () => {
    const rendered = platformEmailTemplateRenderer.render(
      message({
        subject: "Shipment delivered for order ORD-E6K7M8N9",
        templateId: "shipment_delivered",
        templateData: { orderReference: "ORD-E6K7M8N9", trackingNumber: "940000000000000000" },
      }),
    );

    expect(rendered.textBody).toContain("Order reference: ORD-E6K7M8N9");
    expect(rendered.textBody).toContain("Tracking number: 940000000000000000");
    expect(rendered.textBody).not.toContain("ord_01");
    expect(rendered.htmlBody).toContain("Shipment delivered for order ORD-E6K7M8N9");
  });

  it("renders auth magic links as absolute sign-in URLs", () => {
    const rendered = platformEmailTemplateRenderer.render(
      message({
        subject: "Your Chase Sets sign-in link",
        templateId: "auth_magic_link",
        templateData: {
          magicLink: "https://marketplace.chasesets.com/sign-in/magic?token=magic_token&returnTo=%2Faccount",
        },
      }),
    );

    expect(rendered.subject).toBe("Your Chase Sets sign-in link");
    expect(rendered.textBody).toContain("Use this secure link to sign in to Chase Sets:");
    expect(rendered.textBody).toContain(
      "https://marketplace.chasesets.com/sign-in/magic?token=magic_token&returnTo=%2Faccount",
    );
    expect(rendered.textBody).not.toContain("A Chase Sets account update is available.");
  });
});

function message(
  overrides: Pick<TransactionalEmailMessage, "subject" | "templateId" | "templateData">,
): TransactionalEmailMessage {
  return {
    messageType: "public-presence.waitlist-signup.recorded",
    criticality: "operational",
    to: [{ email: "collector@example.com" }],
    templateVersion: 1,
    locale: "en",
    idempotencyKey: "public-presence:waitlist-signup-confirmation:wls_collector",
    correlationId: "req_123",
    actor: { userId: null, accountId: null },
    ...overrides,
  };
}
