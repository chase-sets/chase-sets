import { describe, expect, it } from "vitest";
import {
  AGENT_WEBHOOK_SIGNING_SECRET_PREFIX,
  computeAgentWebhookDigest,
  generateAgentWebhookSigningSecret,
  previewAgentWebhookSigningSecret,
  signAgentWebhookPayload,
  verifyAgentWebhookSignature,
} from "./webhook-signing";

const secret = "whsec_test-secret";
const body = JSON.stringify({ type: "order.updated", order: { id: "ord_1", status: "shipped" } });

describe("agent webhook signing", () => {
  it("produces a deterministic, structured signature header", () => {
    const signature = signAgentWebhookPayload({ signingSecret: secret, body, timestampSeconds: 1_700_000_000 });
    expect(signature.header).toBe(`t=1700000000,v1=${signature.signature}`);
    expect(signature.signature).toMatch(/^[0-9a-f]{64}$/);
    // Same inputs → same digest.
    expect(computeAgentWebhookDigest({ signingSecret: secret, body, timestampSeconds: 1_700_000_000 })).toBe(
      signature.signature,
    );
  });

  it("verifies a signature within the tolerance window", () => {
    const signature = signAgentWebhookPayload({ signingSecret: secret, body, timestampSeconds: 1_700_000_000 });
    expect(
      verifyAgentWebhookSignature({
        signingSecret: secret,
        body,
        header: signature.header,
        nowSeconds: 1_700_000_030,
      }),
    ).toBe(true);
  });

  it("rejects a tampered body", () => {
    const signature = signAgentWebhookPayload({ signingSecret: secret, body, timestampSeconds: 1_700_000_000 });
    expect(
      verifyAgentWebhookSignature({
        signingSecret: secret,
        body: `${body} `,
        header: signature.header,
        nowSeconds: 1_700_000_000,
      }),
    ).toBe(false);
  });

  it("rejects a wrong secret", () => {
    const signature = signAgentWebhookPayload({ signingSecret: secret, body, timestampSeconds: 1_700_000_000 });
    expect(
      verifyAgentWebhookSignature({
        signingSecret: "whsec_other",
        body,
        header: signature.header,
        nowSeconds: 1_700_000_000,
      }),
    ).toBe(false);
  });

  it("rejects a timestamp outside the replay window", () => {
    const signature = signAgentWebhookPayload({ signingSecret: secret, body, timestampSeconds: 1_700_000_000 });
    expect(
      verifyAgentWebhookSignature({
        signingSecret: secret,
        body,
        header: signature.header,
        nowSeconds: 1_700_000_000 + 10 * 60,
      }),
    ).toBe(false);
  });

  it("rejects malformed headers", () => {
    expect(
      verifyAgentWebhookSignature({ signingSecret: secret, body, header: "garbage", nowSeconds: 1_700_000_000 }),
    ).toBe(false);
  });

  it("generates prefixed secrets and only ever previews the tail", () => {
    const generated = generateAgentWebhookSigningSecret();
    expect(generated.startsWith(`${AGENT_WEBHOOK_SIGNING_SECRET_PREFIX}_`)).toBe(true);
    const preview = previewAgentWebhookSigningSecret(generated);
    expect(preview).not.toContain(generated.slice(0, generated.length - 4));
    expect(preview.endsWith(generated.slice(-4))).toBe(true);
  });
});
