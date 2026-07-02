import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const constantSources = {
  PAYMENTS_PROVIDER_WEBHOOK_PATH: "bounded-contexts/payments/features/payments/api/provider-webhook-paths.ts",
  SETTLEMENT_MONEY_MOVEMENT_WEBHOOK_PATH: "bounded-contexts/settlement/features/payouts/api/provider-webhook-paths.ts",
  FULFILLMENT_POSTAGE_WEBHOOK_PATH: "bounded-contexts/fulfillment/features/shipments/api/provider-webhook-paths.ts",
  NOTIFICATIONS_EMAIL_WEBHOOK_PATH:
    "bounded-contexts/notifications/features/notification-center/api/provider-webhook-paths.ts",
  NOTIFICATIONS_MOBILE_MESSAGING_WEBHOOK_PATH:
    "bounded-contexts/notifications/features/notification-center/api/provider-webhook-paths.ts",
};

export function readProviderWebhookPathConstant(name) {
  const sourcePath = constantSources[name];
  if (!sourcePath) {
    throw new Error(`Unknown provider webhook path constant '${name}'.`);
  }

  const source = readFileSync(resolve(rootDir, sourcePath), "utf8");
  const match = new RegExp(`export const ${name} = "([^"]+)";`).exec(source);
  if (!match) {
    throw new Error(`${sourcePath} must export ${name} as a string literal.`);
  }

  return match[1];
}

export const PAYMENTS_PROVIDER_WEBHOOK_PATH = readProviderWebhookPathConstant("PAYMENTS_PROVIDER_WEBHOOK_PATH");
export const SETTLEMENT_MONEY_MOVEMENT_WEBHOOK_PATH = readProviderWebhookPathConstant(
  "SETTLEMENT_MONEY_MOVEMENT_WEBHOOK_PATH",
);
export const FULFILLMENT_POSTAGE_WEBHOOK_PATH = readProviderWebhookPathConstant("FULFILLMENT_POSTAGE_WEBHOOK_PATH");
export const NOTIFICATIONS_EMAIL_WEBHOOK_PATH = readProviderWebhookPathConstant("NOTIFICATIONS_EMAIL_WEBHOOK_PATH");
export const NOTIFICATIONS_MOBILE_MESSAGING_WEBHOOK_PATH = readProviderWebhookPathConstant(
  "NOTIFICATIONS_MOBILE_MESSAGING_WEBHOOK_PATH",
);

export const PROVIDER_WEBHOOK_PATHS = [
  PAYMENTS_PROVIDER_WEBHOOK_PATH,
  SETTLEMENT_MONEY_MOVEMENT_WEBHOOK_PATH,
  FULFILLMENT_POSTAGE_WEBHOOK_PATH,
  NOTIFICATIONS_EMAIL_WEBHOOK_PATH,
  NOTIFICATIONS_MOBILE_MESSAGING_WEBHOOK_PATH,
];
