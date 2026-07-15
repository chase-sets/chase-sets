import type { AccountId, UserId } from "@chase-sets/primitives/typed-ids";

export * from "./transactional-email";

export type KnownNotificationChannelName = "email" | "sms" | "rcs" | "web" | "push";
export type NotificationChannelName = KnownNotificationChannelName | (string & {});
export type KnownNotificationProviderName =
  | "amazon-ses"
  | "local-capture"
  | "twilio"
  | "web-notification-feed"
  | "push-notification-service"
  | "preference-filter"
  | "noop";
export type NotificationProviderName = KnownNotificationProviderName | (string & {});
export type NotificationCriticality = "security" | "commerce" | "operational";
export type NotificationCategory = "security" | "order-critical" | "product-alerts" | "operational" | "legal";
export type NotificationMessageType = `${string}.${string}`;
export type NotificationTemplateData = Readonly<Record<string, string | number | boolean | null>>;
export type NotificationProviderMetadata = Readonly<Record<string, string | number | boolean | null>>;

export type NotificationActor = Readonly<{
  userId?: UserId | null;
  accountId?: AccountId | null;
}>;

export type NotificationEmailAddress = Readonly<{
  email: string;
  displayName?: string | null;
}>;

export type NotificationPhoneNumber = Readonly<{
  e164: string;
  displayName?: string | null;
}>;

export type NotificationRecipient = Readonly<{
  userId?: UserId | null;
  accountId?: AccountId | null;
}>;

export type NotificationChannelProviderOptions = Readonly<{
  providerName?: NotificationProviderName | null;
  providerMetadata?: NotificationProviderMetadata;
}>;

export type EmailNotificationChannel = Readonly<{
  channel: "email";
  to: readonly [NotificationEmailAddress, ...NotificationEmailAddress[]];
  cc?: readonly NotificationEmailAddress[];
  bcc?: readonly NotificationEmailAddress[];
  subject?: string | null;
  templateId?: string | null;
  templateVersion?: number | null;
  templateData?: NotificationTemplateData;
}> &
  NotificationChannelProviderOptions;

export type SmsNotificationChannel = Readonly<{
  channel: "sms";
  to: NotificationPhoneNumber;
  from?: string | null;
  body?: string | null;
  mediaUrls?: readonly string[];
}> &
  NotificationChannelProviderOptions;

export type RcsNotificationChannel = Readonly<{
  channel: "rcs";
  to: NotificationPhoneNumber;
  from?: string | null;
  title?: string | null;
  body?: string | null;
  mediaUrl?: string | null;
  actionHref?: string | null;
  smsFallback?: Omit<SmsNotificationChannel, "channel"> | null;
}> &
  NotificationChannelProviderOptions;

export type WebNotificationRecipient = Readonly<{
  userId?: UserId | null;
  accountId?: AccountId | null;
}>;

export type WebNotificationChannel = Readonly<{
  channel: "web";
  recipient: WebNotificationRecipient;
  title?: string | null;
  body?: string | null;
  actionHref?: string | null;
}> &
  NotificationChannelProviderOptions;

export type PushNotificationChannel = Readonly<{
  channel: "push";
  recipient: NotificationRecipient;
  title?: string | null;
  body?: string | null;
  actionHref?: string | null;
  badgeCount?: number | null;
  collapseKey?: string | null;
}> &
  NotificationChannelProviderOptions;

export type CustomNotificationChannel = Readonly<{
  channel: NotificationChannelName;
  payload: NotificationTemplateData;
}> &
  NotificationChannelProviderOptions;

export type NotificationChannel =
  | EmailNotificationChannel
  | SmsNotificationChannel
  | RcsNotificationChannel
  | WebNotificationChannel
  | PushNotificationChannel
  | CustomNotificationChannel;

export type NotificationMessage = Readonly<{
  messageType: NotificationMessageType;
  criticality: NotificationCriticality;
  /** Optional override for the preference category; criticality supplies the default. */
  category?: NotificationCategory;
  /** Account whose preferences govern this notification. Null is used for anonymous recipients. */
  recipientAccountId?: AccountId | null;
  title: string;
  body: string;
  actionHref?: string | null;
  templateId: string;
  templateVersion: number;
  locale: string;
  templateData: NotificationTemplateData;
  channels: readonly [NotificationChannel, ...NotificationChannel[]];
  idempotencyKey: string;
  correlationId: string;
  actor: NotificationActor;
}>;

export type TransactionalEmailChannel = "transactional";
export type TransactionalEmailProviderName = "amazon-ses" | "local-capture";
export type TransactionalEmailCriticality = NotificationCriticality;
export type TransactionalEmailMessageType = NotificationMessageType;
export type TransactionalEmailAddress = NotificationEmailAddress;

export type TransactionalEmailMessage = Readonly<{
  messageType: TransactionalEmailMessageType;
  criticality: TransactionalEmailCriticality;
  category?: NotificationCategory;
  recipientAccountId?: AccountId | null;
  to: readonly [TransactionalEmailAddress, ...TransactionalEmailAddress[]];
  cc?: readonly TransactionalEmailAddress[];
  bcc?: readonly TransactionalEmailAddress[];
  subject: string;
  templateId: string;
  templateVersion: number;
  locale: string;
  templateData: NotificationTemplateData;
  idempotencyKey: string;
  correlationId: string;
  actor: NotificationActor;
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
  sendTransactionalEmail(message: TransactionalEmailMessage): Promise<SentTransactionalEmailReceipt>;
}

export function createTransactionalEmailNotificationMessage(message: TransactionalEmailMessage): NotificationMessage {
  return {
    messageType: message.messageType,
    criticality: message.criticality,
    ...(message.category ? { category: message.category } : {}),
    ...(message.recipientAccountId !== undefined ? { recipientAccountId: message.recipientAccountId } : {}),
    title: message.subject,
    body: message.subject,
    templateId: message.templateId,
    templateVersion: message.templateVersion,
    locale: message.locale,
    templateData: message.templateData,
    channels: [
      {
        channel: "email",
        to: message.to,
        ...(message.cc ? { cc: message.cc } : {}),
        ...(message.bcc ? { bcc: message.bcc } : {}),
        subject: message.subject,
        templateId: message.templateId,
        templateVersion: message.templateVersion,
        templateData: message.templateData,
      },
    ],
    idempotencyKey: message.idempotencyKey,
    correlationId: message.correlationId,
    actor: message.actor,
  };
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

export type NotificationOutboxStatus = "pending" | "sending" | "sent" | "failed";

export type NotificationOutboxSource = Readonly<{
  sourceEventId: string;
  sourceGlobalPosition: string;
  projectionName: string;
  occurredAt: string;
}>;

export type EnqueueNotificationInput = Readonly<{
  message: NotificationMessage;
  source: NotificationOutboxSource;
  maxAttempts?: number;
  availableAt?: string;
}>;

export type NotificationDelivery = Readonly<{
  deliveryId: string;
  message: NotificationMessage;
  channel: NotificationChannel;
}>;

export type ClaimedNotificationDelivery = NotificationDelivery &
  Readonly<{
    outboxId: string;
    source: NotificationOutboxSource;
    status: NotificationOutboxStatus;
    attemptCount: number;
    maxAttempts: number;
    createdAt: string;
    updatedAt: string;
    nextAttemptAt: string;
    lastError: string | null;
  }>;

export type SentNotificationReceipt = Readonly<{
  channel: NotificationChannelName;
  providerName: NotificationProviderName;
  providerMessageId: string;
  acceptedAt: string;
  attemptCount: number;
}>;

export interface NotificationChannelAdapter {
  channel: NotificationChannelName;
  providerName?: NotificationProviderName;
  sendNotificationChannel(delivery: NotificationDelivery): Promise<SentNotificationReceipt>;
}

export type NotificationChannelAdapterRegistry = Readonly<{
  configuredChannels: readonly NotificationChannelName[];
  adapterForChannel(channel: NotificationChannelName): NotificationChannelAdapter | null;
}>;

export function createNotificationChannelAdapterRegistry(
  adapters: readonly NotificationChannelAdapter[],
): NotificationChannelAdapterRegistry {
  const adapterByChannel = new Map<NotificationChannelName, NotificationChannelAdapter>();

  for (const adapter of adapters) {
    if (adapterByChannel.has(adapter.channel)) {
      throw new Error(`Multiple notification adapters configured for '${adapter.channel}'.`);
    }
    adapterByChannel.set(adapter.channel, adapter);
  }

  return {
    configuredChannels: [...adapterByChannel.keys()],
    adapterForChannel(channel) {
      return adapterByChannel.get(channel) ?? null;
    },
  };
}

export interface NotificationOutbox {
  enqueueNotification(input: EnqueueNotificationInput): Promise<void>;
}

export type ClaimNotificationDeliveriesInput = Readonly<{
  limit: number;
  claimOwnerId: string;
  claimTtlMs: number;
  now?: string;
}>;

export type MarkNotificationDeliverySentInput = Readonly<{
  deliveryId: string;
  receipt: SentNotificationReceipt;
  now?: string;
}>;

export type MarkNotificationDeliveryFailedInput = Readonly<{
  deliveryId: string;
  error: string;
  retryAt?: string | null;
  now?: string;
}>;

export type RenewClaimedNotificationDeliveryInput = Readonly<{
  deliveryId: string;
  claimOwnerId: string;
  claimTtlMs: number;
  now?: string;
}>;

export interface NotificationOutboxStore extends NotificationOutbox {
  claimPendingNotificationDeliveries(
    input: ClaimNotificationDeliveriesInput,
  ): Promise<readonly ClaimedNotificationDelivery[]>;
  renewClaimedNotificationDelivery(input: RenewClaimedNotificationDeliveryInput): Promise<boolean>;
  markNotificationDeliverySent(input: MarkNotificationDeliverySentInput): Promise<void>;
  markNotificationDeliveryFailed(input: MarkNotificationDeliveryFailedInput): Promise<void>;
}

export type MobileMessageProviderWebhookEventKind = "delivery-status" | "inbound-message";

export type MobileMessageProviderWebhookEvent = Readonly<{
  providerEventId: string;
  providerName: NotificationProviderName;
  eventKind: MobileMessageProviderWebhookEventKind;
  providerMessageId: string;
  deliveryId?: string | null;
  status?: string | null;
  failureCode?: string | null;
  failureMessage?: string | null;
  fromPhoneNumber?: string | null;
  toPhoneNumber?: string | null;
  body?: string | null;
  occurredAt: string;
  receivedAt?: string;
}>;

export type MobileMessageProviderWebhookInput = Readonly<{
  rawBody: string;
  url: string;
  contentType?: string | null;
  signatureHeader?: string | null;
}>;

export interface MobileMessageWebhookGateway {
  processMobileMessageWebhook(
    input: MobileMessageProviderWebhookInput,
  ): Promise<MobileMessageProviderWebhookEvent | null>;
}

export function createNoopMobileMessageWebhookGateway(): MobileMessageWebhookGateway {
  return {
    async processMobileMessageWebhook() {
      return null;
    },
  };
}

export type EmailProviderWebhookEventKind = "delivery" | "bounce" | "complaint";

export type EmailProviderWebhookEvent = Readonly<{
  providerEventId: string;
  providerName: NotificationProviderName;
  eventKind: EmailProviderWebhookEventKind;
  providerMessageId: string;
  recipients: readonly string[];
  occurredAt: string;
  receivedAt?: string;
}>;

export type EmailProviderWebhookInput = Readonly<{
  rawBody: string;
  contentType?: string | null;
}>;

export interface EmailWebhookGateway {
  processEmailWebhook(input: EmailProviderWebhookInput): Promise<EmailProviderWebhookEvent | null>;
}

export function createNoopEmailWebhookGateway(): EmailWebhookGateway {
  return {
    async processEmailWebhook() {
      return null;
    },
  };
}

export type NotificationChannelPreference = Readonly<{
  channel: NotificationChannelName | null;
  enabled: boolean;
  messageType?: NotificationMessageType | null;
  category?: NotificationCategory | null;
}>;

export interface NotificationPreferenceResolver {
  listPreferences(accountId: AccountId): Promise<readonly NotificationChannelPreference[]>;
}

export function notificationCategory(
  message: Pick<NotificationMessage, "category" | "criticality">,
): NotificationCategory {
  if (message.criticality === "security") {
    return "security";
  }

  if (message.category) {
    return message.category;
  }

  return message.criticality === "commerce" ? "order-critical" : "operational";
}

export function isNotificationPreferenceMandatory(
  message: Pick<NotificationMessage, "category" | "criticality">,
): boolean {
  const category = notificationCategory(message);
  return category === "security" || category === "order-critical" || category === "legal";
}

export function notificationRecipientAccountId(message: NotificationMessage): AccountId | null {
  if (message.recipientAccountId !== undefined) {
    return message.recipientAccountId;
  }

  if (message.actor.accountId) {
    return message.actor.accountId;
  }

  const webChannel = message.channels.find((channel): channel is WebNotificationChannel => channel.channel === "web");
  return webChannel?.recipient.accountId ?? null;
}

export function applyNotificationChannelPreferences(
  message: NotificationMessage,
  preferences: readonly NotificationChannelPreference[],
): NotificationMessage | null {
  if (isNotificationPreferenceMandatory(message)) {
    return message;
  }

  const category = notificationCategory(message);
  const categoryPreference = preferences.find(
    (preference) =>
      preference.channel === null && preference.category === category && (preference.messageType ?? null) === null,
  );
  if (categoryPreference && !categoryPreference.enabled) {
    return null;
  }

  const channels = message.channels.filter((channel) =>
    isChannelEnabled(message.messageType, channel.channel, preferences),
  );

  if (channels.length === 0) {
    return null;
  }
  const firstChannel = channels[0];
  if (!firstChannel) {
    return null;
  }

  return {
    ...message,
    channels: [firstChannel, ...channels.slice(1)],
  };
}

export function createNotificationDeliveryId(
  message: Pick<NotificationMessage, "idempotencyKey"> & Partial<Pick<NotificationMessage, "channels">>,
  channel: NotificationChannel,
  index: number,
) {
  if (index === 0 && channel.channel === "email" && message.channels?.length === 1) {
    return message.idempotencyKey;
  }

  return [
    "notification-delivery",
    "v1",
    encodeURIComponent(message.idempotencyKey),
    encodeURIComponent(channel.channel),
    String(index + 1),
  ].join(":");
}

function isChannelEnabled(
  messageType: NotificationMessageType,
  channel: NotificationChannelName,
  preferences: readonly NotificationChannelPreference[],
) {
  const exact = preferences.find(
    (preference) => preference.channel === channel && preference.messageType === messageType,
  );
  if (exact) {
    return exact.enabled;
  }

  const channelDefault = preferences.find(
    (preference) => preference.channel === channel && (preference.messageType ?? null) === null,
  );

  return channelDefault?.enabled ?? true;
}

export function createNoopNotificationAdapter(channel: NotificationChannelName): NotificationChannelAdapter {
  return {
    channel,
    providerName: "noop",
    async sendNotificationChannel(delivery) {
      return {
        channel: delivery.channel.channel,
        providerName: "noop",
        providerMessageId: `noop:${delivery.deliveryId}`,
        acceptedAt: new Date().toISOString(),
        attemptCount: 0,
      };
    },
  };
}

export function createNoopNotificationOutbox(): NotificationOutboxStore {
  return {
    async enqueueNotification() {
      return undefined;
    },
    async claimPendingNotificationDeliveries() {
      return [];
    },
    async renewClaimedNotificationDelivery() {
      return true;
    },
    async markNotificationDeliverySent() {
      return undefined;
    },
    async markNotificationDeliveryFailed() {
      return undefined;
    },
  };
}
