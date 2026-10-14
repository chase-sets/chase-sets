import { definePolicy } from "@chase-sets/platform-policy/define-policy";

export const ebayReceiptRetention = { retentionSeconds: 2592000, sweepSeconds: 3600, batchSize: 500 } as const;
export const ebayReceiptRetentionPolicy = definePolicy({
  policyKey: "channels.ebay-account-deletion-receipt-retention",
  contextName: "channels",
  schemaSummary:
    "channels.ebay-account-deletion-receipt-retention/v1: fixed 30-day retention, 3600-second overrun, 500 per DELETE",
  defaultValue: ebayReceiptRetention,
  decodeValue(value: unknown) {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).length !== 3 ||
      Object.entries(ebayReceiptRetention).some(([name, expected]) => Reflect.get(value, name) !== expected)
    )
      throw new Error("invalid-ebay-receipt-retention-policy");
    return ebayReceiptRetention;
  },
});
