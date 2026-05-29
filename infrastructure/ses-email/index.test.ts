import { describe, expect, it, vi } from "vitest";
import {
  createSesSendRequest,
  createSesEmailNotificationAdapter,
  createSesTransactionalEmailGateway,
  parseSesNotificationEvent,
  type SesSendEmailRequest,
} from ".";
import type { TransactionalEmailMessage } from "@chase-sets/communications-email";

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
    expect(request.Content.Simple.Body.Text.Data).toContain("https://chasesets.com/magic");
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
