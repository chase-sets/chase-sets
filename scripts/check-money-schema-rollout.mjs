#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const checks = [
  {
    file: "bounded-contexts/payments/features/payments/read-model/schema.ts",
    required: [
      "payments_provider_idempotency_keys",
      "payments_reconciliation_runs",
      "payments_provider_webhook_events",
      "balance_credit_amount",
      "processor_payment_kind",
      "processor_redirect_url",
      "ADD COLUMN IF NOT EXISTS balance_credit_amount",
      "ADD COLUMN IF NOT EXISTS processor_payment_kind",
    ],
  },
  {
    file: "bounded-contexts/settlement/features/payout-readiness/read-model/schema.ts",
    required: [
      "settlement_payout_readiness_pages",
      "provider_reference",
      "onboarding_status",
      "transfer_capability_status",
      "payout_capability_status",
      "payout_destination_status",
      "ADD COLUMN IF NOT EXISTS onboarding_status",
      "ADD COLUMN IF NOT EXISTS transfer_capability_status",
      "ADD COLUMN IF NOT EXISTS payout_capability_status",
      "ADD COLUMN IF NOT EXISTS payout_destination_status",
    ],
  },
  {
    file: "bounded-contexts/settlement/features/payouts/read-model/schema.ts",
    required: [
      "settlement_money_movement_webhook_events",
      "settlement_provider_idempotency_keys",
      "settlement_reconciliation_runs",
      "provider_transfer_reference",
      "provider_payout_reference",
      "provider_status",
      "provider_failure_code",
      "provider_failure_message",
      "last_provider_event_at",
      "last_reconciled_at",
      "retry_count",
      "ADD COLUMN IF NOT EXISTS provider_transfer_reference",
      "ADD COLUMN IF NOT EXISTS provider_payout_reference",
      "ADD COLUMN IF NOT EXISTS provider_status",
      "ADD COLUMN IF NOT EXISTS provider_failure_code",
      "ADD COLUMN IF NOT EXISTS provider_failure_message",
      "ADD COLUMN IF NOT EXISTS last_reconciled_at",
      "ADD COLUMN IF NOT EXISTS retry_count",
    ],
  },
];

const failures = [];

for (const check of checks) {
  const absolutePath = path.join(root, check.file);
  const content = await readFile(absolutePath, "utf8");
  for (const expected of check.required) {
    if (!content.includes(expected)) {
      failures.push(`${check.file} is missing '${expected}'.`);
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Money schema rollout checks passed.");
}
