import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  createLocalEmailCaptureGateway,
  createLocalEmailCaptureNotificationAdapter,
  type LocalEmailCaptureRecord,
} from ".";
import type { TransactionalEmailMessage } from "@chase-sets/notifications";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("local email capture", () => {
  const templateRenderer = {
    render: (message: TransactionalEmailMessage) => ({
      subject: `${message.subject} [rendered]`,
      htmlBody: `<p>${message.templateData.magicLink ?? message.templateData.orderId}</p>`,
      textBody: String(message.templateData.magicLink ?? message.templateData.orderId ?? ""),
    }),
  };

  it("captures rendered transactional email as JSONL", async () => {
    const captureFilePath = await createCaptureFilePath();
    const gateway = createLocalEmailCaptureGateway({
      captureFilePath,
      templateRenderer,
      now: () => new Date("2026-05-31T10:00:00.000Z"),
    });

    const receipt = await gateway.sendTransactionalEmail({
      messageType: "auth.magic-link.requested",
      criticality: "security",
      to: [{ email: "buyer@example.com" }],
      subject: "Your sign-in link",
      templateId: "auth_magic_link",
      templateVersion: 1,
      locale: "en",
      templateData: { magicLink: "http://localhost/magic" },
      idempotencyKey: "auth:magic:tok_1",
      correlationId: "req_1",
      actor: { userId: null, accountId: null },
    });

    expect(receipt).toEqual({
      providerName: "local-capture",
      providerMessageId: "local-capture:auth:magic:tok_1",
      acceptedAt: "2026-05-31T10:00:00.000Z",
      attemptCount: 1,
    });
    await expect(readCaptureRecords(captureFilePath)).resolves.toEqual([
      expect.objectContaining({
        source: "transactional-email",
        providerName: "local-capture",
        providerMessageId: "local-capture:auth:magic:tok_1",
        subject: "Your sign-in link [rendered]",
        rendered: expect.objectContaining({ textBody: "http://localhost/magic" }),
      }),
    ]);
  });

  it("captures notification email channel deliveries as rendered email", async () => {
    const captureFilePath = await createCaptureFilePath();
    const adapter = createLocalEmailCaptureNotificationAdapter({
      captureFilePath,
      templateRenderer,
      now: () => new Date("2026-05-31T10:00:00.000Z"),
    });

    const receipt = await adapter.sendNotificationChannel({
      deliveryId: "ordering:order_confirmed:ord_1:email:1",
      message: {
        messageType: "ordering.order.created",
        criticality: "commerce",
        title: "Order confirmed",
        body: "Order ord_1 is confirmed.",
        templateId: "order_confirmed",
        templateVersion: 1,
        locale: "en",
        templateData: { orderId: "ord_1" },
        channels: [{ channel: "email", to: [{ email: "buyer@example.com" }] }],
        idempotencyKey: "ordering:order_confirmed:ord_1",
        correlationId: "req_1",
        actor: { userId: null, accountId: null },
      },
      channel: { channel: "email", to: [{ email: "buyer@example.com" }] },
    });

    expect(receipt).toEqual({
      channel: "email",
      providerName: "local-capture",
      providerMessageId: "local-capture:ordering:order_confirmed:ord_1:email:1",
      acceptedAt: "2026-05-31T10:00:00.000Z",
      attemptCount: 1,
    });
    await expect(readCaptureRecords(captureFilePath)).resolves.toEqual([
      expect.objectContaining({
        source: "notification-channel",
        idempotencyKey: "ordering:order_confirmed:ord_1:email:1",
        rendered: expect.objectContaining({ textBody: "ord_1" }),
      }),
    ]);
  });
});

async function createCaptureFilePath() {
  const dir = await mkdtemp(join(tmpdir(), "chase-sets-local-email-capture-"));
  tempDirs.push(dir);
  return join(dir, "capture", "emails.jsonl");
}

async function readCaptureRecords(captureFilePath: string) {
  const content = await readFile(captureFilePath, "utf8");
  return content
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LocalEmailCaptureRecord);
}
