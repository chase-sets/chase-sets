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
    subject: "You officially joined the Chase Sets waitlist",
    templateId: "waitlist_signup_confirmation",
    templateVersion: 1,
    locale: "en",
    templateData: {
      signupId: input.signupId,
      status: "joined",
      nextStep: "We will send early access updates as beta invites open.",
    },
    idempotencyKey: `public-presence:waitlist-signup-confirmation:${input.signupId}`,
    correlationId: input.correlationId,
    actor: { userId: null, accountId: null },
  };
}
