import type { TransactionalEmailMessage } from "@chase-sets/communications-email";

export type WaitlistSignupConfirmationEmailIntentInput = Readonly<{
  email: string;
  signupId: string;
  correlationId: string;
}>;

export function mapWaitlistSignupRecordedToTransactionalEmail(
  input: WaitlistSignupConfirmationEmailIntentInput,
): TransactionalEmailMessage {
  return {
    messageType: "public-presence.waitlist-signup.recorded",
    criticality: "operational",
    to: [{ email: input.email }],
    subject: "Welcome to Chase Sets early access",
    templateId: "waitlist_signup_confirmation",
    templateVersion: 1,
    locale: "en",
    templateData: {
      headline: "You are on the early access list.",
      intro:
        "Thanks for requesting early access. Chase Sets is building a faster card marketplace for collectors who want sharper pricing, lower seller fees, and cleaner buying and selling workflows.",
      nextStep: "We will send launch updates and beta invites as access opens.",
    },
    idempotencyKey: `public-presence:waitlist-signup-confirmation:${input.signupId}`,
    correlationId: input.correlationId,
    actor: { userId: null, accountId: null },
  };
}
