import { createSign, generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createSesEmailWebhookGateway,
  createSesSendRequest,
  createSesEmailNotificationAdapter,
  createSesTransactionalEmailGateway,
  parseSesNotificationEvent,
  type SesSendEmailRequest,
} from ".";
import type { TransactionalEmailMessage } from "@chase-sets/outbound-messaging";

describe("ses email adapter", () => {
  const templateRenderer = {
    render: (message: TransactionalEmailMessage) => ({
      subject: `${message.subject} [en]`,
      htmlBody: `<p>${message.templateData.magicLink}</p>`,
      textBody: String(message.templateData.magicLink),
    }),
  };

  it("creates an AWS SDK send request from SES request input", async () => {
    const send = vi.fn(async (_command: { input: { FromEmailAddress?: string } }) => ({ MessageId: "ses_msg_sdk" }));
    const sendRequest = createSesSendRequest({
      region: "us-east-2",
      client: { send },
    });

    const response = await sendRequest({
      FromEmailAddress: "notifications@chasesets.com",
      Destination: { ToAddresses: ["buyer@example.com"] },
      Content: {
        Simple: {
          Subject: { Data: "Order confirmed", Charset: "UTF-8" },
          Body: {
            Html: { Data: "<p>Order confirmed</p>", Charset: "UTF-8" },
            Text: { Data: "Order confirmed", Charset: "UTF-8" },
          },
          Headers: [],
        },
      },
      EmailTags: [],
    });

    expect(response).toEqual({ MessageId: "ses_msg_sdk" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0].input.FromEmailAddress).toBe("notifications@chasesets.com");
  });

  it("maps transactional messages into SES SendEmail requests", async () => {
    const sendRequest = vi.fn(async (_request: SesSendEmailRequest) => ({ MessageId: "ses_msg_123" }));
    const gateway = createSesTransactionalEmailGateway({
      fromEmail: "no-reply@chasesets.com",
      configurationSetName: "transactional",
      sourceArn: "arn:aws:ses:us-east-1:123456789012:identity/chasesets.com",
      sendRequest,
      templateRenderer,
      now: () => new Date("2026-05-09T00:00:00.000Z"),
    });

    const receipt = await gateway.sendTransactionalEmail({
      messageType: "auth.magic-link.requested",
      criticality: "security",
      to: [{ email: "buyer@example.com" }],
      subject: "Your sign-in link",
      templateId: "auth_magic_link",
      templateVersion: 1,
      locale: "en",
      templateData: { magicLink: "https://chasesets.com/magic" },
      idempotencyKey: "auth:magic:usr_123",
      correlationId: "req_123",
      actor: { userId: null, accountId: null },
    });

    expect(receipt).toEqual({
      providerName: "amazon-ses",
      providerMessageId: "ses_msg_123",
      acceptedAt: "2026-05-09T00:00:00.000Z",
      attemptCount: 1,
    });
    const [request] = sendRequest.mock.calls[0] as [SesSendEmailRequest];
    expect(request.FromEmailAddress).toBe("Chase Sets <no-reply@chasesets.com>");
    expect(request.Content.Simple.Body.Text.Data).toContain("https://chasesets.com/magic");
  });

  it("supports explicit friendly sender display names", async () => {
    const sendRequest = vi.fn(async (_request: SesSendEmailRequest) => ({ MessageId: "ses_msg_sender" }));
    const gateway = createSesTransactionalEmailGateway({
      fromEmail: "notifications@chasesets.com",
      fromName: "Chase Sets Early Access",
      sendRequest,
      templateRenderer,
    });

    await gateway.sendTransactionalEmail({
      messageType: "public-presence.waitlist-signup.recorded",
      criticality: "operational",
      to: [{ email: "collector@example.com" }],
      subject: "Welcome to Chase Sets early access",
      templateId: "waitlist_signup_confirmation",
      templateVersion: 1,
      locale: "en",
      templateData: { magicLink: "welcome" },
      idempotencyKey: "public-presence:waitlist-signup-confirmation:wls_123",
      correlationId: "req_123",
      actor: { userId: null, accountId: null },
    });

    const [request] = sendRequest.mock.calls[0] as [SesSendEmailRequest];
    expect(request.FromEmailAddress).toBe("Chase Sets Early Access <notifications@chasesets.com>");
  });

  it("preserves preformatted SES sender addresses", async () => {
    const sendRequest = vi.fn(async (_request: SesSendEmailRequest) => ({ MessageId: "ses_msg_sender" }));
    const gateway = createSesTransactionalEmailGateway({
      fromEmail: "Chase Sets <notifications@chasesets.com>",
      sendRequest,
      templateRenderer,
    });

    await gateway.sendTransactionalEmail({
      messageType: "auth.magic-link.requested",
      criticality: "security",
      to: [{ email: "buyer@example.com" }],
      subject: "Your sign-in link",
      templateId: "auth_magic_link",
      templateVersion: 1,
      locale: "en",
      templateData: { magicLink: "https://chasesets.com/magic" },
      idempotencyKey: "auth:magic:usr_123",
      correlationId: "req_123",
      actor: { userId: null, accountId: null },
    });

    const [request] = sendRequest.mock.calls[0] as [SesSendEmailRequest];
    expect(request.FromEmailAddress).toBe("Chase Sets <notifications@chasesets.com>");
  });

  it("retries transient failures and emits observability hooks", async () => {
    const onAttempt = vi.fn();
    const onResult = vi.fn();
    const sendRequest = vi
      .fn(async (_request: SesSendEmailRequest) => ({ MessageId: "ses_msg_retry" }))
      .mockRejectedValueOnce(new Error("temporary SES outage"))
      .mockResolvedValueOnce({ MessageId: "ses_msg_retry" });

    const gateway = createSesTransactionalEmailGateway({
      fromEmail: "no-reply@chasesets.com",
      sendRequest,
      templateRenderer,
      onAttempt,
      onResult,
      maxAttempts: 2,
    });

    const receipt = await gateway.sendTransactionalEmail({
      messageType: "ordering.order.created",
      criticality: "commerce",
      to: [{ email: "buyer@example.com" }],
      subject: "Order confirmed",
      templateId: "order_confirmed",
      templateVersion: 1,
      locale: "en",
      templateData: { orderId: "ord_123" },
      idempotencyKey: "ord:123",
      correlationId: "req_abc",
      actor: { userId: null, accountId: null },
    });

    expect(receipt.attemptCount).toBe(2);
    expect(onAttempt).toHaveBeenCalledTimes(2);
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it("parses SES SNS notification envelopes", () => {
    const parsed = parseSesNotificationEvent(
      JSON.stringify({
        Message: JSON.stringify({
          eventType: "Bounce",
          mail: {
            messageId: "ses_msg_123",
            timestamp: "2026-05-09T00:00:00.000Z",
            destination: ["buyer@example.com"],
          },
        }),
      }),
    );

    expect(parsed).toEqual({
      messageId: "ses_msg_123",
      eventType: "Bounce",
      occurredAt: "2026-05-09T00:00:00.000Z",
      recipients: ["buyer@example.com"],
    });
  });

  it("normalizes SES notification envelopes into provider-neutral email webhook events", async () => {
    const message = JSON.stringify({
      eventType: "Complaint",
      mail: {
        messageId: "ses_msg_complaint",
        timestamp: "2026-05-09T00:00:00.000Z",
        destination: ["buyer@example.com"],
      },
    });
    const body = buildSignedSnsEnvelope({
      Message: message,
      MessageId: "sns_msg_1",
      Timestamp: "2026-05-09T00:00:00.000Z",
      TopicArn: "arn:aws:sns:us-east-2:123456789012:ses-transactional",
    });
    const gateway = createSesEmailWebhookGateway({
      fetchCertificate: async () => body.publicKey,
      now: () => new Date("2026-05-09T00:00:01.000Z"),
    });

    await expect(
      gateway.processEmailWebhook({
        rawBody: body.rawBody,
        contentType: "application/json",
      }),
    ).resolves.toEqual({
      providerEventId: "amazon-ses:ses_msg_complaint:complaint:2026-05-09T00:00:00.000Z",
      providerName: "amazon-ses",
      eventKind: "complaint",
      providerMessageId: "ses_msg_complaint",
      recipients: ["buyer@example.com"],
      occurredAt: "2026-05-09T00:00:00.000Z",
      receivedAt: "2026-05-09T00:00:01.000Z",
    });
  });

  it("confirms signed SNS subscription confirmation envelopes", async () => {
    const subscribeUrl =
      "https://sns.us-east-2.amazonaws.com/?Action=ConfirmSubscription&TopicArn=arn%3Aaws%3Asns%3Aus-east-2%3A123456789012%3Ases-transactional&Token=token_123";
    const body = buildSignedSnsEnvelope({
      Type: "SubscriptionConfirmation",
      Message: "You have chosen to subscribe to the topic.",
      MessageId: "sns_msg_subscription",
      SubscribeURL: subscribeUrl,
      Timestamp: "2026-05-09T00:00:00.000Z",
      Token: "token_123",
      TopicArn: "arn:aws:sns:us-east-2:123456789012:ses-transactional",
    });
    const confirmSubscription = vi.fn(async () => undefined);
    const gateway = createSesEmailWebhookGateway({
      fetchCertificate: async () => body.publicKey,
      confirmSubscription,
    });

    await expect(
      gateway.processEmailWebhook({
        rawBody: body.rawBody,
        contentType: "application/json",
      }),
    ).resolves.toBeNull();

    expect(confirmSubscription).toHaveBeenCalledWith(subscribeUrl);
  });

  it("rejects signed SNS subscription confirmations with untrusted subscribe urls", async () => {
    const body = buildSignedSnsEnvelope({
      Type: "SubscriptionConfirmation",
      Message: "You have chosen to subscribe to the topic.",
      MessageId: "sns_msg_subscription",
      SubscribeURL: "https://example.com/?Action=ConfirmSubscription&Token=token_123",
      Timestamp: "2026-05-09T00:00:00.000Z",
      Token: "token_123",
      TopicArn: "arn:aws:sns:us-east-2:123456789012:ses-transactional",
    });
    const gateway = createSesEmailWebhookGateway({
      fetchCertificate: async () => body.publicKey,
      confirmSubscription: vi.fn(async () => undefined),
    });

    await expect(
      gateway.processEmailWebhook({
        rawBody: body.rawBody,
        contentType: "application/json",
      }),
    ).rejects.toThrow("SNS subscription confirmation URL is not trusted.");
  });

  it("rejects unsigned SES webhook payloads when SNS signature verification is required", async () => {
    const gateway = createSesEmailWebhookGateway();

    await expect(
      gateway.processEmailWebhook({
        rawBody: JSON.stringify({
          eventType: "Bounce",
          mail: {
            messageId: "ses_msg_123",
            timestamp: "2026-05-09T00:00:00.000Z",
            destination: ["buyer@example.com"],
          },
        }),
      }),
    ).rejects.toThrow("SES email webhooks must be delivered through a signed SNS notification.");
  });

  it("can parse direct SES event payloads for local provider simulations", async () => {
    const gateway = createSesEmailWebhookGateway({
      requireSnsSignature: false,
      now: () => new Date("2026-05-09T00:00:01.000Z"),
    });

    await expect(
      gateway.processEmailWebhook({
        rawBody: JSON.stringify({
          eventType: "Delivery",
          mail: {
            messageId: "ses_msg_direct",
            timestamp: "2026-05-09T00:00:00.000Z",
            destination: ["buyer@example.com"],
          },
        }),
      }),
    ).resolves.toMatchObject({
      providerEventId: "amazon-ses:ses_msg_direct:delivery:2026-05-09T00:00:00.000Z",
      eventKind: "delivery",
      providerMessageId: "ses_msg_direct",
    });
  });

  it("ignores SES notification events without a provider message id", () => {
    expect(
      parseSesNotificationEvent(
        JSON.stringify({
          eventType: "Delivery",
          mail: {
            timestamp: "2026-05-09T00:00:00.000Z",
            destination: ["buyer@example.com"],
          },
        }),
      ),
    ).toBeNull();
  });

  it("adapts notification email channels through transactional SES rendering", async () => {
    const sendRequest = vi.fn(async (_request: SesSendEmailRequest) => ({ MessageId: "ses_msg_notify" }));
    const adapter = createSesEmailNotificationAdapter({
      fromEmail: "no-reply@chasesets.com",
      sendRequest,
      templateRenderer,
      now: () => new Date("2026-05-09T00:00:00.000Z"),
    });

    const receipt = await adapter.sendNotificationChannel({
      deliveryId: "ordering:order_confirmed:ord_123:email:1",
      message: {
        messageType: "ordering.order.created",
        criticality: "commerce",
        title: "Order confirmed",
        body: "Order ord_123 is confirmed.",
        templateId: "order_confirmed",
        templateVersion: 1,
        locale: "en",
        templateData: { magicLink: "ord_123" },
        channels: [{ channel: "email", to: [{ email: "buyer@example.com" }] }],
        idempotencyKey: "ordering:order_confirmed:ord_123",
        correlationId: "req_123",
        actor: { userId: null, accountId: null },
      },
      channel: { channel: "email", to: [{ email: "buyer@example.com" }] },
    });

    expect(receipt).toEqual({
      channel: "email",
      providerName: "amazon-ses",
      providerMessageId: "ses_msg_notify",
      acceptedAt: "2026-05-09T00:00:00.000Z",
      attemptCount: 1,
    });
    const [request] = sendRequest.mock.calls[0] as [SesSendEmailRequest];
    expect(request.Content.Simple.Headers).toContainEqual({
      Name: "X-ChaseSets-Idempotency-Key",
      Value: "ordering:order_confirmed:ord_123:email:1",
    });
  });
});

function buildSignedSnsEnvelope(input: Readonly<SignedSnsEnvelopeInput>) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const envelope = {
    Type: input.Type ?? "Notification",
    Message: input.Message,
    MessageId: input.MessageId,
    Timestamp: input.Timestamp,
    TopicArn: input.TopicArn,
    SignatureVersion: "2",
    SigningCertURL: "https://sns.us-east-2.amazonaws.com/SimpleNotificationService.pem",
    ...(input.SubscribeURL ? { SubscribeURL: input.SubscribeURL } : {}),
    ...(input.Token ? { Token: input.Token } : {}),
  };
  const fields =
    envelope.Type === "Notification"
      ? ["Message", "MessageId", "Timestamp", "TopicArn", "Type"]
      : ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"];
  const stringToSign = fields
    .flatMap((field) => [field, String(envelope[field as keyof typeof envelope])])
    .map((value) => `${value}\n`)
    .join("");
  const signature = createSign("RSA-SHA256").update(stringToSign).end().sign(privateKey, "base64");

  return {
    rawBody: JSON.stringify({
      ...envelope,
      Signature: signature,
    }),
    publicKey: publicKey.export({ format: "pem", type: "spki" }).toString(),
  };
}

type SignedSnsEnvelopeInput = Readonly<{
  Type?: "Notification" | "SubscriptionConfirmation";
  Message: string;
  MessageId: string;
  SubscribeURL?: string;
  Timestamp: string;
  Token?: string;
  TopicArn: string;
}>;
