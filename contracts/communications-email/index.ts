import type { AccountId, UserId } from "@chase-sets/primitives/typed-ids";

export type TransactionalEmailChannel = "transactional";
export type TransactionalEmailProviderName = "amazon-ses";
export type TransactionalEmailCriticality = "security" | "commerce" | "operational";
export type TransactionalEmailMessageType = `${string}.${string}`;

export type TransactionalEmailAddress = Readonly<{
  email: string;
  displayName?: string | null;
}>;

export type TransactionalEmailMessage = Readonly<{
  messageType: TransactionalEmailMessageType;
  criticality: TransactionalEmailCriticality;
  to: readonly [TransactionalEmailAddress, ...TransactionalEmailAddress[]];
  cc?: readonly TransactionalEmailAddress[];
  bcc?: readonly TransactionalEmailAddress[];
  subject: string;
  templateId: string;
  templateVersion: number;
  locale: string;
  templateData: Readonly<Record<string, string | number | boolean | null>>;
  idempotencyKey: string;
  correlationId: string;
  actor: Readonly<{
    userId?: UserId | null;
    accountId?: AccountId | null;
  }>;
}>;

export type RenderedTransactionalEmail = Readonly<{
  subject: string;
  htmlBody: string;
  textBody: string;
}>;

export interface TransactionalEmailTemplateRenderer {
  render(message: TransactionalEmailMessage): RenderedTransactionalEmail;
}

export type SentTransactionalEmailReceipt = Readonly<{
  providerName: TransactionalEmailProviderName;
  providerMessageId: string;
  acceptedAt: string;
  attemptCount: number;
}>;

export interface TransactionalEmailGateway {
  sendTransactionalEmail(
    message: TransactionalEmailMessage,
  ): Promise<SentTransactionalEmailReceipt>;
}

export function createNoopTransactionalEmailGateway(): TransactionalEmailGateway {
  return {
    async sendTransactionalEmail(message) {
      return {
        providerName: "amazon-ses",
        providerMessageId: `noop:${message.idempotencyKey}`,
        acceptedAt: new Date().toISOString(),
        attemptCount: 0,
      };
    },
  };
}
