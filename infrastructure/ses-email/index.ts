import {
  SendEmailCommand,
  SESv2Client,
  type SendEmailCommandInput,
  type SESv2ClientConfig,
} from "@aws-sdk/client-sesv2";
import type {
  SentTransactionalEmailReceipt,
  TransactionalEmailGateway,
  TransactionalEmailMessage,
  TransactionalEmailTemplateRenderer,
} from "@chase-sets/communications-email";
import type {
  EmailNotificationChannel,
  NotificationChannelAdapter,
  NotificationDelivery,
  SentNotificationReceipt,
} from "@chase-sets/notifications";
import {
  ProviderAdapterError,
  providerFailureCategoryFromHttpStatus,
  providerFailureCategoryFromText,
} from "@chase-sets/http/provider-errors";

export type SesEmailGatewayOptions = Readonly<{
  fromEmail: string;
  configurationSetName?: string | null;
  sourceArn?: string | null;
  maxAttempts?: number;
  templateRenderer: TransactionalEmailTemplateRenderer;
  sendRequest: (input: SesSendEmailRequest) => Promise<SesSendEmailResponse>;
  onAttempt?: (event: { messageType: string; attempt: number; correlationId: string }) => void;
  onResult?: (event: { messageType: string; success: boolean; error?: string | null }) => void;
  now?: () => Date;
}>;

export type SesSendRequestOptions = Readonly<{
  region: string;
  clientConfig?: Omit<SESv2ClientConfig, "region">;
  client?: Pick<SESv2Client, "send">;
}>;

export type SesSendEmailRequest = Readonly<{
  FromEmailAddress: string;
  Destination: Readonly<{
    ToAddresses: readonly string[];
    CcAddresses?: readonly string[];
    BccAddresses?: readonly string[];
  }>;
  Content: Readonly<{
    Simple: Readonly<{
      Subject: Readonly<{ Data: string; Charset: "UTF-8" }>;
      Body: Readonly<{
        Html: Readonly<{ Data: string; Charset: "UTF-8" }>;
        Text: Readonly<{ Data: string; Charset: "UTF-8" }>;
      }>;
      Headers: readonly Readonly<{ Name: string; Value: string }>[];
    }>;
  }>;
  ConfigurationSetName?: string;
  FromEmailAddressIdentityArn?: string;
  EmailTags: readonly Readonly<{ Name: string; Value: string }>[];
}>;

export type SesSendEmailResponse = Readonly<{ MessageId: string }>;

export type SesNotificationEvent = Readonly<{
  messageId: string;
  eventType: "Delivery" | "Bounce" | "Complaint";
  occurredAt: string;
  recipients: readonly string[];
}>;

type SesNotificationEnvelope = Readonly<{
  Message?: unknown;
  eventType?: unknown;
  mail?: Readonly<{
    messageId?: unknown;
    timestamp?: unknown;
    destination?: unknown;
  }>;
}>;

function normalizeOptional(value?: string | null) {
  const n = value?.trim() ?? "";
  return n.length > 0 ? n : null;
}

function mapError(error: unknown) {
  if (error instanceof ProviderAdapterError) return error;
  const message = error instanceof Error ? error.message : "SES send failed.";
  return new ProviderAdapterError(
    providerFailureCategoryFromText(message, providerFailureCategoryFromHttpStatus(502)),
    message,
    502,
  );
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export function createSesSendRequest(options: SesSendRequestOptions) {
  const client = options.client ?? new SESv2Client({ ...options.clientConfig, region: options.region });

  return async (input: SesSendEmailRequest): Promise<SesSendEmailResponse> => {
    const response = await client.send(new SendEmailCommand(toAwsSendEmailCommandInput(input)));
    if (!response.MessageId) {
      throw new Error("SES did not return a message id.");
    }

    return { MessageId: response.MessageId };
  };
}

function toAwsSendEmailCommandInput(input: SesSendEmailRequest): SendEmailCommandInput {
  return {
    FromEmailAddress: input.FromEmailAddress,
    Destination: {
      ToAddresses: [...input.Destination.ToAddresses],
      ...(input.Destination.CcAddresses ? { CcAddresses: [...input.Destination.CcAddresses] } : {}),
      ...(input.Destination.BccAddresses ? { BccAddresses: [...input.Destination.BccAddresses] } : {}),
    },
    Content: {
      Simple: {
        Subject: { ...input.Content.Simple.Subject },
        Body: {
          Html: { ...input.Content.Simple.Body.Html },
          Text: { ...input.Content.Simple.Body.Text },
        },
        Headers: input.Content.Simple.Headers.map((header) => ({ ...header })),
      },
    },
    EmailTags: input.EmailTags.map((tag) => ({ ...tag })),
    ...(input.ConfigurationSetName ? { ConfigurationSetName: input.ConfigurationSetName } : {}),
    ...(input.FromEmailAddressIdentityArn ? { FromEmailAddressIdentityArn: input.FromEmailAddressIdentityArn } : {}),
  };
}

export function parseSesNotificationEvent(rawBody: string): SesNotificationEvent | null {
  const body = JSON.parse(rawBody) as SesNotificationEnvelope;
  const message = (typeof body.Message === "string" ? JSON.parse(body.Message) : body) as SesNotificationEnvelope;
  const eventType = typeof message.eventType === "string" ? message.eventType : "";
  if (!["Delivery", "Bounce", "Complaint"].includes(eventType)) return null;
  const destination = Array.isArray(message.mail?.destination) ? message.mail.destination : [];
  const recipients = destination.filter((v): v is string => typeof v === "string");
  return {
    messageId: String(message.mail?.messageId ?? ""),
    eventType: eventType as SesNotificationEvent["eventType"],
    occurredAt: String(message.mail?.timestamp ?? new Date().toISOString()),
    recipients,
  };
}

export function createSesTransactionalEmailGateway(options: SesEmailGatewayOptions): TransactionalEmailGateway {
  const now = options.now ?? (() => new Date());
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);

  return {
    async sendTransactionalEmail(message: TransactionalEmailMessage): Promise<SentTransactionalEmailReceipt> {
      const configurationSetName = normalizeOptional(options.configurationSetName);
      const sourceArn = normalizeOptional(options.sourceArn);
      const rendered = options.templateRenderer.render(message);
      const toAddresses = message.to.map((item) => item.email);
      const ccAddresses = message.cc?.map((item) => item.email);
      const bccAddresses = message.bcc?.map((item) => item.email);

      const input: SesSendEmailRequest = {
        FromEmailAddress: options.fromEmail,
        Destination: {
          ToAddresses: toAddresses,
          ...(ccAddresses && ccAddresses.length > 0 ? { CcAddresses: ccAddresses } : {}),
          ...(bccAddresses && bccAddresses.length > 0 ? { BccAddresses: bccAddresses } : {}),
        },
        Content: {
          Simple: {
            Subject: { Data: rendered.subject, Charset: "UTF-8" },
            Body: {
              Html: { Data: rendered.htmlBody, Charset: "UTF-8" },
              Text: { Data: rendered.textBody, Charset: "UTF-8" },
            },
            Headers: [
              { Name: "X-ChaseSets-Message-Type", Value: message.messageType },
              { Name: "X-ChaseSets-Template-Id", Value: message.templateId },
              { Name: "X-ChaseSets-Template-Version", Value: String(message.templateVersion) },
              { Name: "X-ChaseSets-Idempotency-Key", Value: message.idempotencyKey },
              { Name: "X-ChaseSets-Correlation-Id", Value: message.correlationId },
            ],
          },
        },
        EmailTags: [
          { Name: "message_type", Value: message.messageType },
          { Name: "template_id", Value: message.templateId },
          { Name: "criticality", Value: message.criticality },
        ],
        ...(configurationSetName ? { ConfigurationSetName: configurationSetName } : {}),
        ...(sourceArn ? { FromEmailAddressIdentityArn: sourceArn } : {}),
      };

      let attempt = 0;
      let lastError: ProviderAdapterError | null = null;
      while (attempt < maxAttempts) {
        attempt += 1;
        options.onAttempt?.({ messageType: message.messageType, attempt, correlationId: message.correlationId });
        try {
          const response = await options.sendRequest(input);
          options.onResult?.({ messageType: message.messageType, success: true });
          return {
            providerName: "amazon-ses",
            providerMessageId: response.MessageId,
            acceptedAt: now().toISOString(),
            attemptCount: attempt,
          };
        } catch (error) {
          lastError = mapError(error);
          options.onResult?.({ messageType: message.messageType, success: false, error: lastError.message });
          if (attempt >= maxAttempts) throw lastError;
          await sleep(attempt * 25);
        }
      }

      throw lastError ?? mapError(new Error("SES send failed."));
    },
  };
}

export function createSesEmailNotificationAdapter(options: SesEmailGatewayOptions): NotificationChannelAdapter {
  const gateway = createSesTransactionalEmailGateway(options);

  return {
    channel: "email",
    providerName: "amazon-ses",
    async sendNotificationChannel(delivery: NotificationDelivery): Promise<SentNotificationReceipt> {
      const channel = assertEmailChannel(delivery.channel);
      const receipt = await gateway.sendTransactionalEmail({
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
      });

      return {
        channel: "email",
        providerName: receipt.providerName,
        providerMessageId: receipt.providerMessageId,
        acceptedAt: receipt.acceptedAt,
        attemptCount: receipt.attemptCount,
      };
    },
  };
}

function assertEmailChannel(channel: NotificationDelivery["channel"]): EmailNotificationChannel {
  if (channel.channel !== "email") {
    throw new Error(`SES email adapter cannot send '${channel.channel}'.`);
  }

  return channel as EmailNotificationChannel;
}
