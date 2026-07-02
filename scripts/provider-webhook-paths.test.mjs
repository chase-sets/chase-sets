import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FULFILLMENT_POSTAGE_WEBHOOK_PATH,
  NOTIFICATIONS_EMAIL_WEBHOOK_PATH,
  NOTIFICATIONS_MOBILE_MESSAGING_WEBHOOK_PATH,
  PAYMENTS_PROVIDER_WEBHOOK_PATH,
  PROVIDER_WEBHOOK_PATHS,
  SETTLEMENT_MONEY_MOVEMENT_WEBHOOK_PATH,
  readProviderWebhookPathConstant,
} from "./provider-webhook-paths.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const expectedPaths = [
  PAYMENTS_PROVIDER_WEBHOOK_PATH,
  SETTLEMENT_MONEY_MOVEMENT_WEBHOOK_PATH,
  FULFILLMENT_POSTAGE_WEBHOOK_PATH,
  NOTIFICATIONS_EMAIL_WEBHOOK_PATH,
  NOTIFICATIONS_MOBILE_MESSAGING_WEBHOOK_PATH,
];

const scannedRoots = ["docs/runbooks", ".github/workflows"];

describe("provider webhook paths", () => {
  it("reads exported context constants as the runtime source of truth", () => {
    expect(PROVIDER_WEBHOOK_PATHS).toEqual(expectedPaths);
    expect(readProviderWebhookPathConstant("PAYMENTS_PROVIDER_WEBHOOK_PATH")).toBe(PAYMENTS_PROVIDER_WEBHOOK_PATH);
    expect(readProviderWebhookPathConstant("SETTLEMENT_MONEY_MOVEMENT_WEBHOOK_PATH")).toBe(
      SETTLEMENT_MONEY_MOVEMENT_WEBHOOK_PATH,
    );
    expect(readProviderWebhookPathConstant("FULFILLMENT_POSTAGE_WEBHOOK_PATH")).toBe(FULFILLMENT_POSTAGE_WEBHOOK_PATH);
    expect(readProviderWebhookPathConstant("NOTIFICATIONS_EMAIL_WEBHOOK_PATH")).toBe(NOTIFICATIONS_EMAIL_WEBHOOK_PATH);
    expect(readProviderWebhookPathConstant("NOTIFICATIONS_MOBILE_MESSAGING_WEBHOOK_PATH")).toBe(
      NOTIFICATIONS_MOBILE_MESSAGING_WEBHOOK_PATH,
    );
  });

  it("keeps runbook and workflow provider webhook literals aligned to exported paths", () => {
    const allowedPaths = new Set(PROVIDER_WEBHOOK_PATHS);
    const findings = scanWebhookPathLiterals(scannedRoots);
    const unknown = findings.filter((finding) => !allowedPaths.has(finding.path));

    expect(unknown).toEqual([]);
    expect(findings.map((finding) => finding.path)).toEqual(expect.arrayContaining(PROVIDER_WEBHOOK_PATHS.slice(1, 4)));
  });
});

function scanWebhookPathLiterals(roots) {
  return roots.flatMap((root) =>
    listFiles(resolve(rootDir, root)).flatMap((filePath) => {
      const source = readFileSync(filePath, "utf8");
      const matches = [...source.matchAll(/\/api\/[A-Za-z0-9_./:-]*provider[A-Za-z0-9_./:-]*webhooks/g)].map(
        (match) => ({
          filePath: filePath.slice(rootDir.length + 1).replaceAll("\\", "/"),
          path: match[0],
        }),
      );

      return matches;
    }),
  );
}

function listFiles(root) {
  return readdirSync(root).flatMap((entry) => {
    const filePath = join(root, entry);
    const stat = statSync(filePath);
    if (stat.isDirectory()) {
      return listFiles(filePath);
    }
    return [filePath];
  });
}
