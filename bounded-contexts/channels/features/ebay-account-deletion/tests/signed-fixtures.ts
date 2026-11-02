import { createECDH, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { vi } from "vitest";
import { createEbayAccountDeletionRoutes, type EbayAccountDeletionOptions } from "../api/route";
import { createEbayDeletionKeyAuthority } from "../api/signature";
import { notice } from "./fixtures";

// Synthetic scalar keys and subjects only; no provider capture or replay bytes.
export function syntheticKey(scalar = 1) {
  const ec = createECDH("prime256v1");
  const d = Buffer.alloc(32);
  d[31] = scalar;
  ec.setPrivateKey(d);
  const point = ec.getPublicKey();
  const privateKey = createPrivateKey({
    format: "jwk",
    key: {
      kty: "EC",
      crv: "P-256",
      d: d.toString("base64url"),
      x: point.subarray(1, 33).toString("base64url"),
      y: point.subarray(33).toString("base64url"),
    },
  });
  return { privateKey, publicKey: createPublicKey(privateKey).export({ format: "pem", type: "spki" }).toString() };
}
export const config = {
  endpoint: "https://synthetic.example/api/channels-webhooks/ebay/account-deletion",
  verificationToken: "synthetic_verification_token_0123456789",
  applicationAuthority: {
    clientId: "synthetic-client",
    clientSecret: "synthetic-secret-marker",
    environment: "sandbox" as const,
  },
};
export const payload = {
  metadata: { topic: notice.topic, schemaVersion: "1.0", deprecated: false },
  notification: {
    notificationId: notice.notificationId,
    eventDate: notice.eventDate,
    publishDate: notice.publishDate,
    publishAttemptCount: notice.publishAttemptCount,
    data: { username: "synthetic-username-marker", userId: notice.userId, eiasToken: "synthetic-eias-marker" },
  },
};
export const path = "/ebay/account-deletion";
export function signedHeader(value: unknown = payload, scalar = 1, kid = "synthetic-kid") {
  return Buffer.from(
    JSON.stringify({
      alg: "ECDSA",
      digest: "sha256",
      kid,
      signature: sign("sha256", Buffer.from(JSON.stringify(value)), syntheticKey(scalar).privateKey).toString("base64"),
    }),
  ).toString("base64");
}
export function keyFetcher(publicKey = syntheticKey().publicKey) {
  return vi.fn<typeof fetch>(async (url) =>
    String(url).includes("/oauth2/token")
      ? Response.json({ access_token: "synthetic-access-token-marker", expires_in: 7200 })
      : Response.json({ algorithm: "ECDSA", digest: "sha256", key: publicKey }),
  );
}
export function signedApp(overrides: Partial<EbayAccountDeletionOptions> = {}, fetcher = keyFetcher()) {
  const recordReceipt = vi.fn<NonNullable<EbayAccountDeletionOptions["recordReceipt"]>>(async () => "recorded");
  const record = vi.fn();
  const app = createEbayAccountDeletionRoutes({
    config,
    keyAuthority: createEbayDeletionKeyAuthority(config.applicationAuthority, fetcher),
    recordReceipt,
    telemetry: { record },
    ...overrides,
  });
  return { app, recordReceipt, record, fetcher };
}
export function post(
  app: ReturnType<typeof createEbayAccountDeletionRoutes>,
  value: unknown = payload,
  header = signedHeader(value),
) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-ebay-signature": header },
    body: JSON.stringify(value),
  });
}
