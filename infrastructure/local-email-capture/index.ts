import { mkdir, appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  RenderedTransactionalEmail,
  SentTransactionalEmailReceipt,
  TransactionalEmailGateway,
  TransactionalEmailMessage,
  TransactionalEmailTemplateRenderer,
} from "@chase-sets/notifications";
import type {
  EmailNotificationChannel,
  NotificationChannelAdapter,
  NotificationDelivery,
  SentNotificationReceipt,
} from "@chase-sets/notifications";

export type LocalEmailCaptureSource = "transactional-email" | "notification-channel";

export type LocalEmailCaptureRecord = Readonly<{
  schemaVersion: 1;
  source: LocalEmailCaptureSource;
  providerName: "local-capture";
  providerMessageId: string;
  acceptedAt: string;
  messageType: string;
  criticality: string;
  subject: string;
  templateId: string;
  templateVersion: number;
  locale: string;
  idempotencyKey: string;
  correlationId: string;
  to: readonly Readonly<{ email: string; displayName?: string | null }>[];
  cc: readonly Readonly<{ email: string; displayName?: string | null }>[];
  bcc: readonly Readonly<{ email: string; displayName?: string | null }>[];
  rendered: RenderedTransactionalEmail;
}>;

export type LocalEmailCaptureOptions = Readonly<{
  captureFilePath: string;
  templateRenderer: TransactionalEmailTemplateRenderer;
  now?: () => Date;
}>;

export function createLocalEmailCaptureGateway(options: LocalEmailCaptureOptions): TransactionalEmailGateway {
  const now = options.now ?? (() => new Date());

  return {
    async sendTransactionalEmail(message): Promise<SentTransactionalEmailReceipt> {
      const acceptedAt = now().toISOString();
      const providerMessageId = `local-capture:${message.idempotencyKey}`;
      await captureTransactionalEmail({
        options,
        message,
        source: "transactional-email",
        providerMessageId,
        acceptedAt,
      });

      return {
        providerName: "local-capture",
        providerMessageId,
        acceptedAt,
        attemptCount: 1,
      };
    },
  };
}

export function createLocalEmailCaptureNotificationAdapter(
  options: LocalEmailCaptureOptions,
): NotificationChannelAdapter {
  const now = options.now ?? (() => new Date());

  return {
    channel: "email",
    providerName: "local-capture",
    async sendNotificationChannel(delivery: NotificationDelivery): Promise<SentNotificationReceipt> {
      const channel = assertEmailChannel(delivery.channel);
      const acceptedAt = now().toISOString();
      const providerMessageId = `local-capture:${delivery.deliveryId}`;

      await captureTransactionalEmail({
        options,
        message: notificationDeliveryToTransactionalEmail(delivery, channel),
        source: "notification-channel",
        providerMessageId,
        acceptedAt,
      });

      return {
        channel: "email",
        providerName: "local-capture",
        providerMessageId,
        acceptedAt,
        attemptCount: 1,
      };
    },
  };
}

async function captureTransactionalEmail(input: {
  options: LocalEmailCaptureOptions;
  message: TransactionalEmailMessage;
  source: LocalEmailCaptureSource;
  providerMessageId: string;
  acceptedAt: string;
}) {
  const rendered = input.options.templateRenderer.render(input.message);
  const record: LocalEmailCaptureRecord = {
    schemaVersion: 1,
    source: input.source,
    providerName: "local-capture",
    providerMessageId: input.providerMessageId,
    acceptedAt: input.acceptedAt,
    messageType: input.message.messageType,
    criticality: input.message.criticality,
    subject: rendered.subject,
    templateId: input.message.templateId,
    templateVersion: input.message.templateVersion,
    locale: input.message.locale,
    idempotencyKey: input.message.idempotencyKey,
    correlationId: input.message.correlationId,
    to: input.message.to,
    cc: input.message.cc ?? [],
    bcc: input.message.bcc ?? [],
    rendered,
  };

  await mkdir(dirname(input.options.captureFilePath), { recursive: true });
  await appendFile(input.options.captureFilePath, `${JSON.stringify(record)}\n`, "utf8");
}

function notificationDeliveryToTransactionalEmail(
  delivery: NotificationDelivery,
  channel: EmailNotificationChannel,
): TransactionalEmailMessage {
  return {
    messageType: delivery.message.messageType,
    criticality: delivery.message.criticality,
    to: channel.to,
    cc: channel.cc,
    bcc: channel.bcc,
    subject: channel.subject?.trim() || delivery.message.title,
    templateId: channel.templateId?.trim() || delivery.message.templateId,
    templateVersion: channel.templateVersion ?? delivery.message.templateVersion,
    locale: delivery.message.locale,
    templateData: {
      ...delivery.message.templateData,
      ...(channel.templateData ?? {}),
    },
    idempotencyKey: delivery.deliveryId,
    correlationId: delivery.message.correlationId,
    actor: delivery.message.actor,
  };
}

function assertEmailChannel(channel: NotificationDelivery["channel"]): EmailNotificationChannel {
  if (channel.channel !== "email") {
    throw new Error(`Local email capture adapter cannot send '${channel.channel}'.`);
  }

  return channel as EmailNotificationChannel;
}
