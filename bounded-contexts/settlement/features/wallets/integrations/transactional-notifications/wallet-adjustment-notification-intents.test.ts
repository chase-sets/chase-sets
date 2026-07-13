import { describe, expect, it } from "vitest";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import {
  mapWalletAdjustmentPostedToNotification,
  mapWalletAdjustmentReversedToNotification,
  walletAdjustmentCustomerReasonCategoryLabel,
} from "./wallet-adjustment-notification-intents";

const targetAccountId = "acc_seller" as AccountId;

describe("mapWalletAdjustmentPostedToNotification", () => {
  it("maps an ordinary credit to a web-only notice when no contact email is on file", () => {
    const message = mapWalletAdjustmentPostedToNotification({
      adjustmentId: "wad_01JZ6DKP7S7Z4AZ5N5E6K7M8N9",
      targetAccountId,
      direction: "credit",
      amount: "40.00",
      currencyCode: "usd",
      reasonCode: "goodwill-cash-credit",
      resultingBalanceAmount: "50.00",
      isReversalPosting: false,
      correlationId: "req_1",
    });

    expect(message.messageType).toBe("settlement.wallet-adjustment.posted");
    expect(message.recipientAccountId).toBe(targetAccountId);
    expect(message.idempotencyKey).toBe("settlement:wallet_adjustment_posted:wad_01JZ6DKP7S7Z4AZ5N5E6K7M8N9");
    expect(message.channels).toHaveLength(1);
    expect(message.channels[0]!.channel).toBe("web");
    expect(message.actionHref).toBe("/account/wallet/adjustments/WAD-E6K7M8N9");
    expect(message.title).not.toContain("[missing:");
    expect(message.body).not.toContain("[missing:");
    expect(message.body).toContain("WAD-E6K7M8N9");
  });

  it("includes an email channel when a contact email is on file, and never leaks the raw adjustment id", () => {
    const message = mapWalletAdjustmentPostedToNotification({
      adjustmentId: "wad_01JZ6DKP7S7Z4AZ5N5E6K7M8N9",
      targetAccountId,
      targetAccountEmail: "seller@example.com",
      direction: "debit",
      amount: "10.00",
      currencyCode: "usd",
      reasonCode: "fee-correction",
      resultingBalanceAmount: "30.00",
      isReversalPosting: false,
      correlationId: "req_2",
    });

    expect(message.channels).toHaveLength(2);
    expect(message.channels.map((channel) => channel.channel)).toEqual(["email", "web"]);
    // The raw adjustment id is a legitimate internal dedup key, but every
    // customer-visible surface must use the support-safe display reference.
    const customerVisibleSurface = JSON.stringify({
      title: message.title,
      body: message.body,
      actionHref: message.actionHref,
      templateData: message.templateData,
    });
    expect(customerVisibleSurface).not.toContain("wad_01JZ6DKP7S7Z4AZ5N5E6K7M8N9");
  });

  it("labels every closed reason code without a missing-translation sentinel", () => {
    const reasonCodes = [
      "transaction-correction",
      "refund-correction",
      "fee-correction",
      "dispute-resolution",
      "fraud-recovery",
      "support-resolution",
      "legal-obligation",
      "goodwill-cash-credit",
      "operational-error",
      "other-with-required-detail",
    ] as const;

    for (const reasonCode of reasonCodes) {
      expect(walletAdjustmentCustomerReasonCategoryLabel(reasonCode)).not.toContain("[missing:");
    }
  });
});

describe("mapWalletAdjustmentReversedToNotification", () => {
  it("links the original and correcting entries by their support-safe references", () => {
    const message = mapWalletAdjustmentReversedToNotification({
      originalAdjustmentId: "wad_01JZ6DKP7S7Z4AZ5N5E6K7M8N9",
      reversalAdjustmentId: "wad_01JZ6DKP7S7Z4AZ5N5E6K7M8P1",
      targetAccountId,
      originalDirection: "debit",
      amount: "20.00",
      currencyCode: "usd",
      resultingBalanceAmount: "50.00",
      correlationId: "req_3",
    });

    expect(message.messageType).toBe("settlement.wallet-adjustment.reversed");
    expect(message.idempotencyKey).toBe("settlement:wallet_adjustment_reversed:wad_01JZ6DKP7S7Z4AZ5N5E6K7M8N9");
    expect(message.templateData.originalReference).toBe("WAD-E6K7M8N9");
    expect(message.templateData.reversalReference).toBe("WAD-E6K7M8P1");
    expect(message.actionHref).toBe("/account/wallet/adjustments/WAD-E6K7M8N9");
    const customerVisibleSurface = JSON.stringify({
      title: message.title,
      body: message.body,
      actionHref: message.actionHref,
      templateData: message.templateData,
    });
    expect(customerVisibleSurface).not.toContain("wad_01JZ6DKP7S7Z4AZ5N5E6K7M8N9");
    expect(customerVisibleSurface).not.toContain("wad_01JZ6DKP7S7Z4AZ5N5E6K7M8P1");
  });
});
