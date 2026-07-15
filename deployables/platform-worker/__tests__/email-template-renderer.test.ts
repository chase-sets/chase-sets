import { describe, expect, it } from "vitest";
import type { TransactionalEmailMessage } from "@chase-sets/outbound-messaging";
import { platformEmailTemplateRenderer } from "../src/email-template-renderer";

describe("platform email template renderer", () => {
  it.each([
    "waitlist_nurture_welcome",
    "waitlist_nurture_fee_lock",
    "waitlist_nurture_open_offers",
    "waitlist_nurture_wave_approaching",
    "waitlist_nurture_wave_admitted",
  ])("renders %s with its tracked content and referral links", (templateId) => {
    const rendered = platformEmailTemplateRenderer.render(
      message({
        subject: "Your Chase Sets update",
        templateId,
        templateData: {
          headline: "A plain-language update.",
          intro: "The useful detail comes first.",
          detailsLink:
            "https://chasesets.com/sales-fees?utm_source=waitlist_email&utm_medium=email&utm_campaign=waitlist_nurture",
          referralLink:
            "https://chasesets.com/?ref=wls_collector&utm_source=referral&utm_medium=waitlist_email&utm_campaign=waitlist_nurture",
        },
      }),
    );

    expect(rendered.textBody).toContain("A plain-language update.");
    expect(rendered.textBody).toContain("Open the next step:");
    expect(rendered.textBody).toContain("Your referral link:");
    expect(rendered.textBody).toContain("utm_campaign=waitlist_nurture");
    expect(rendered.htmlBody).toContain("utm_source=waitlist_email");
    expect(rendered.textBody).not.toContain("A Chase Sets account update is available.");
  });

  it("renders the welcome offer, Discord, referral, and admission preference links explicitly", () => {
    const welcome = platformEmailTemplateRenderer.render(
      message({
        subject: "Welcome to Chase Sets early access",
        templateId: "waitlist_nurture_welcome",
        templateData: {
          foundersTermsLink: "https://chasesets.com/founders?utm_source=waitlist_email",
          discordInviteLink: "https://chasesets.com/welcome?utm_content=discord_invite_welcome",
          referralLink: "https://chasesets.com/?ref=wls_test&utm_medium=waitlist_email",
        },
      }),
    );
    const admission = platformEmailTemplateRenderer.render(
      message({
        subject: "Your Chase Sets beta access is open",
        templateId: "waitlist_nurture_wave_admitted",
        templateData: {
          preferencesLink: "https://marketplace.chasesets.com/?notifications=settings",
        },
      }),
    );

    expect(welcome.textBody).toContain("Read the founders offer terms:");
    expect(welcome.textBody).toContain("Open your founders circle Discord invite:");
    expect(welcome.textBody).toContain("Your referral link:");
    expect(welcome.textBody).toContain("because you joined the Chase Sets waitlist");
    expect(admission.textBody).toContain("Manage early-access email preferences:");
  });

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

  it("renders support-case email copy with the display reference", () => {
    const rendered = platformEmailTemplateRenderer.render(
      message({
        subject: "Support request SUP-E6K7M8N9 opened for order ORD-E6K7M8N9",
        templateId: "support_request_opened",
        templateData: {
          supportReference: "SUP-E6K7M8N9",
          supportRequestId: "sup_01JZ6DKP7S7Z4AZ5N5E6K7M8N9",
          orderId: "ord_01JZ6DKP7S7Z4AZ5N5E6K7M8N9",
          flowType: "product-not-received",
        },
      }),
    );

    expect(rendered.textBody).toContain("Support reference: SUP-E6K7M8N9");
    expect(rendered.textBody).not.toContain("sup_01JZ6DKP7S7Z4AZ5N5E6K7M8N9");
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

  it("renders invitation acceptance links with account and role context", () => {
    const rendered = platformEmailTemplateRenderer.render(
      message({
        subject: "You're invited to Competitive Cards",
        templateId: "auth_invitation_acceptance_link",
        templateData: {
          invitationLink: "https://marketplace.chasesets.com/invite/ivt_1?token=invite_token",
          accountName: "Competitive Cards",
          roleLabel: "Member",
        },
      }),
    );

    expect(rendered.subject).toBe("You're invited to Competitive Cards");
    expect(rendered.textBody).toContain("Competitive Cards");
    expect(rendered.textBody).toContain("Member");
    expect(rendered.textBody).toContain("https://marketplace.chasesets.com/invite/ivt_1?token=invite_token");
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
