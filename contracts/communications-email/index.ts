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

export type TransactionalEmailOutboxStatus = "pending" | "sending" | "sent" | "failed";

export type TransactionalEmailOutboxSource = Readonly<{
  sourceEventId: string;
  sourceGlobalPosition: string;
  projectionName: string;
  occurredAt: string;
}>;

export type EnqueueTransactionalEmailInput = Readonly<{
  message: TransactionalEmailMessage;
  source: TransactionalEmailOutboxSource;
  maxAttempts?: number;
  availableAt?: string;
}>;

export type ClaimedTransactionalEmail = Readonly<{
  outboxId: string;
  message: TransactionalEmailMessage;
  source: TransactionalEmailOutboxSource;
  status: TransactionalEmailOutboxStatus;
  attemptCount: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
  nextAttemptAt: string;
  lastError: string | null;
}>;

export interface TransactionalEmailGateway {
  sendTransactionalEmail(message: TransactionalEmailMessage): Promise<SentTransactionalEmailReceipt>;
}

export interface TransactionalEmailOutbox {
  enqueueTransactionalEmail(input: EnqueueTransactionalEmailInput): Promise<void>;
}

export type ClaimTransactionalEmailsInput = Readonly<{
  limit: number;
  claimOwnerId: string;
  claimTtlMs: number;
  now?: string;
}>;

export type MarkTransactionalEmailSentInput = Readonly<{
  idempotencyKey: string;
  receipt: SentTransactionalEmailReceipt;
  now?: string;
}>;

export type MarkTransactionalEmailFailedInput = Readonly<{
  idempotencyKey: string;
  error: string;
  retryAt?: string | null;
  now?: string;
}>;

export interface TransactionalEmailOutboxStore extends TransactionalEmailOutbox {
  claimPendingTransactionalEmails(input: ClaimTransactionalEmailsInput): Promise<readonly ClaimedTransactionalEmail[]>;
  markTransactionalEmailSent(input: MarkTransactionalEmailSentInput): Promise<void>;
  markTransactionalEmailFailed(input: MarkTransactionalEmailFailedInput): Promise<void>;
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

export function createNoopTransactionalEmailOutbox(): TransactionalEmailOutboxStore {
  return {
    async enqueueTransactionalEmail() {
      return undefined;
    },
    async claimPendingTransactionalEmails() {
      return [];
    },
    async markTransactionalEmailSent() {
      return undefined;
    },
    async markTransactionalEmailFailed() {
      return undefined;
    },
  };
}
