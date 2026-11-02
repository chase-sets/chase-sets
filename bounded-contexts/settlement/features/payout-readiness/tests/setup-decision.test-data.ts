import type { SettlementPayoutReadinessRow } from "../read-model/queries";
import type { PayoutSetupDecision } from "../domain/setup-progress";

export function payoutReadinessFixture(
  overrides: Partial<SettlementPayoutReadinessRow> = {},
): SettlementPayoutReadinessRow {
  return {
    account_id: "acc_seller",
    status: "pending",
    missing_requirements: [],
    advisory_requirements: [],
    disabled_reason: null,
    requirements_deadline: null,
    provider_reference: "acct_test",
    contact_email: null,
    onboarding_status: "complete",
    transfer_capability_status: "active",
    payout_capability_status: "active",
    payout_destination_status: "ready",
    payout_destination_fingerprint: null,
    payout_destination_changed_at: null,
    payout_account_dashboard: "none",
    losses_collector: "application",
    fees_collector: "application",
    requirements_collector: "application",
    updated_at: "2026-06-01T15:00:00.000Z",
    ...overrides,
  };
}

type MatrixRow = Readonly<{
  name: string;
  projection: SettlementPayoutReadinessRow;
  expected: PayoutSetupDecision;
  title: string | null;
}>;

const available = { support_recommended: false, provider_setup_available: true, provider_management_available: true };
const restricted = { ...available, support_recommended: true };

export const payoutSetupMatrix: readonly MatrixRow[] = [
  {
    name: "ready",
    projection: payoutReadinessFixture({ status: "ready" }),
    expected: { ...available, next_step: "none", provider_setup_available: false },
    title: null,
  },
  {
    name: "ready without provider",
    projection: payoutReadinessFixture({ status: "ready", provider_reference: null }),
    expected: {
      ...available,
      next_step: "none",
      provider_setup_available: false,
      provider_management_available: false,
    },
    title: null,
  },
  {
    name: "restricted precedes ordinary groups",
    projection: payoutReadinessFixture({ status: "restricted", missing_requirements: ["external_account"] }),
    expected: { ...restricted, next_step: "restricted" },
    title: "Payout setup is restricted",
  },
  {
    name: "groups precede missing destination",
    projection: payoutReadinessFixture({
      missing_requirements: ["external_account"],
      payout_destination_status: "missing",
    }),
    expected: { ...restricted, next_step: "complete_requirements" },
    title: "Payout setup details need attention",
  },
  {
    name: "restricted precedes platform-only groups without enabling setup",
    projection: payoutReadinessFixture({
      status: "restricted",
      missing_requirements: ["provider_dashboard_posture"],
    }),
    expected: { ...restricted, next_step: "restricted", provider_setup_available: false },
    title: "Payout setup is restricted",
  },
  {
    name: "ready precedes groups while recommending support without recovery",
    projection: payoutReadinessFixture({ status: "ready", missing_requirements: ["external_account"] }),
    expected: { ...restricted, next_step: "none", provider_setup_available: false },
    title: null,
  },
  {
    name: "past due wins all reason matches",
    projection: payoutReadinessFixture({ status: "restricted", disabled_reason: "past_due.review.rejected.paused" }),
    expected: { ...restricted, next_step: "restricted_past_due" },
    title: "Payout setup is restricted",
  },
  {
    name: "review wins rejected and paused",
    projection: payoutReadinessFixture({ status: "restricted", disabled_reason: "REVIEW.rejected.paused" }),
    expected: { ...restricted, next_step: "restricted_review" },
    title: "Payout setup is restricted",
  },
  {
    name: "pending reason",
    projection: payoutReadinessFixture({ status: "restricted", disabled_reason: "requirements.pending" }),
    expected: { ...restricted, next_step: "restricted_review" },
    title: "Payout setup is restricted",
  },
  {
    name: "rejected wins paused",
    projection: payoutReadinessFixture({ status: "restricted", disabled_reason: "rejected.paused" }),
    expected: { ...restricted, next_step: "restricted_rejected" },
    title: "Payout setup is restricted",
  },
  {
    name: "fraud reason",
    projection: payoutReadinessFixture({ status: "restricted", disabled_reason: "fraud" }),
    expected: { ...restricted, next_step: "restricted_rejected" },
    title: "Payout setup is restricted",
  },
  {
    name: "paused reason",
    projection: payoutReadinessFixture({ status: "restricted", disabled_reason: "paused" }),
    expected: { ...restricted, next_step: "restricted_paused" },
    title: "Payout setup is restricted",
  },
  {
    name: "inactivity reason",
    projection: payoutReadinessFixture({ status: "restricted", disabled_reason: "inactivity" }),
    expected: { ...restricted, next_step: "restricted_paused" },
    title: "Payout setup is restricted",
  },
  {
    name: "unknown restricted reason",
    projection: payoutReadinessFixture({ status: "restricted", disabled_reason: "future.reason" }),
    expected: { ...restricted, next_step: "restricted" },
    title: "Payout setup is restricted",
  },
  {
    name: "empty restricted reason",
    projection: payoutReadinessFixture({ status: "restricted", disabled_reason: "" }),
    expected: { ...restricted, next_step: "restricted" },
    title: "Payout setup is restricted",
  },
  {
    name: "absent restricted reason",
    projection: payoutReadinessFixture({ status: "restricted" }),
    expected: { ...restricted, next_step: "restricted" },
    title: "Payout setup is restricted",
  },
  {
    name: "platform groups",
    projection: payoutReadinessFixture({
      missing_requirements: ["provider_dashboard_posture", "provider_fee_payer_posture"],
    }),
    expected: { ...restricted, next_step: "platform_review", provider_setup_available: false },
    title: "Platform review",
  },
  {
    name: "ordinary groups",
    projection: payoutReadinessFixture({ missing_requirements: ["external_account"] }),
    expected: { ...restricted, next_step: "complete_requirements" },
    title: "Payout setup details need attention",
  },
  {
    name: "mixed groups",
    projection: payoutReadinessFixture({
      missing_requirements: ["provider_dashboard_posture", "individual.verification.document"],
    }),
    expected: { ...restricted, next_step: "complete_requirements" },
    title: "Payout setup details need attention",
  },
  {
    name: "missing destination precedes pending",
    projection: payoutReadinessFixture({
      payout_destination_status: "missing",
      onboarding_status: "pending",
      provider_reference: null,
    }),
    expected: { ...available, next_step: "add_destination", provider_management_available: false },
    title: "Add a payout destination",
  },
  ...(
    [
      "onboarding_status",
      "transfer_capability_status",
      "payout_capability_status",
      "payout_destination_status",
    ] as const
  ).map(
    (field): MatrixRow => ({
      name: `pending ${field}`,
      projection: payoutReadinessFixture({ [field]: "pending" }),
      expected: { ...available, next_step: "provider_review" },
      title: "Provider review is in progress",
    }),
  ),
  {
    name: "otherwise non-ready",
    projection: payoutReadinessFixture(),
    expected: { ...available, next_step: "none" },
    title: "Payout setup can continue",
  },
  {
    name: "unknown requirement",
    projection: payoutReadinessFixture({ missing_requirements: ["future.unknown"] }),
    expected: { ...restricted, next_step: "complete_requirements" },
    title: "Payout setup details need attention",
  },
];
