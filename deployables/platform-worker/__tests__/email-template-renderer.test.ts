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
