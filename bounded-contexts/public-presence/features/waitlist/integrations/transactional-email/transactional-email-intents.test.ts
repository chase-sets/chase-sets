import { describe, expect, it } from "vitest";
import { mapWaitlistSignupRecordedToTransactionalEmail } from "./transactional-email-intents";

describe("waitlist transactional email intents", () => {
  it("maps recorded waitlist signups to confirmation email messages", () => {
    const message = mapWaitlistSignupRecordedToTransactionalEmail({
      email: "collector@example.com",
      signupId: "wls_collector",
      correlationId: "req_123",
    });

    expect(message.messageType).toBe("public-presence.waitlist-signup.recorded");
    expect(message.criticality).toBe("operational");
    expect(message.to[0]?.email).toBe("collector@example.com");
    expect(message.subject).toContain("officially joined");
    expect(message.templateId).toBe("waitlist_signup_confirmation");
    expect(message.templateData.status).toBe("joined");
    expect(message.idempotencyKey).toBe(
      "public-presence:waitlist-signup-confirmation:wls_collector",
    );
  });
});
