import { describe, expect, it } from "vitest";
import { describeGoogleMerchantConfigForLogs } from "../config";

describe("google merchant config", () => {
  it("redacts Google Merchant credential references from log descriptions", () => {
    const description = describeGoogleMerchantConfigForLogs({
      syncEnabled: true,
      dryRun: false,
      merchantAccountId: "123456",
      apiDataSourceId: "7890",
      targetCountry: "US",
      contentLanguage: "en",
      feedLabel: "US",
      credentialSecretName: "google-merchant-service-account",
      productionSyncApprovalReference: "GOOGLE-SHOPPING-SYNC-APPROVAL-2026-06-04",
    });

    expect(description).toEqual({
      syncEnabled: true,
      dryRun: false,
      merchantAccountId: "123456",
      apiDataSourceId: "7890",
      targetCountry: "US",
      contentLanguage: "en",
      feedLabel: "US",
      credentialSecretName: "[configured]",
      productionSyncApprovalReference: "GOOGLE-SHOPPING-SYNC-APPROVAL-2026-06-04",
    });
  });
});
