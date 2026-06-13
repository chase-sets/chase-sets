import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { paymentsOrderInputSchemaSql } from "../features/payments/integrations/order-input/order-input-schema";
import { paymentsPaymentSchemaSql } from "../features/payments/read-model/schema";
import { paymentsSupportRefundEffectSchemaSql } from "../features/refunds/integrations/support/support-refund-effect-schema";

const paymentsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(paymentsRoot, "..", "..");

describe("fresh payments schemas", () => {
  it("keeps final checkout payment columns in base schemas without compatibility shims", () => {
    const checkoutAdjacentSchemas = [
      paymentsPaymentSchemaSql,
      paymentsOrderInputSchemaSql,
      paymentsSupportRefundEffectSchemaSql,
    ];

    for (const schema of checkoutAdjacentSchemas) {
      expect(schema).not.toMatch(/ADD COLUMN IF NOT EXISTS/i);
      expect(schema).not.toMatch(/DROP CONSTRAINT/i);
      expect(schema).not.toMatch(/regexp_replace\(support_request_id/i);
      expect(schema).not.toMatch(/request_json/i);
    }

    expect(paymentsPaymentSchemaSql).toContain("balance_credit_amount numeric(12, 2) NOT NULL DEFAULT 0");
    expect(paymentsPaymentSchemaSql).toContain("saved_checkout_instrument_id text NULL");
    expect(paymentsPaymentSchemaSql).toContain("readiness text NOT NULL CHECK");
    expect(paymentsOrderInputSchemaSql).toContain("source_reference_id text NULL");
    expect(paymentsOrderInputSchemaSql).toContain("shipping_allowance_percentage_bps integer NOT NULL DEFAULT 500");
    expect(paymentsSupportRefundEffectSchemaSql).toContain("refund_effect_id text NOT NULL");
  });

  it("keeps Payments localization free of schema and query payloads", () => {
    const localization = readFileSync(resolve(repoRoot, "contracts/localization/locales/en/payments.ts"), "utf8");

    expect(localization).not.toContain("CREATE TABLE IF NOT EXISTS payments_");
    expect(localization).not.toContain("ALTER TABLE payments_");
    expect(localization).not.toContain("FROM payments_payment_pages");
    expect(localization).not.toMatch(/payments\.features\.[^"]*(?:schema|queries|Schema)\./);
  });
});
