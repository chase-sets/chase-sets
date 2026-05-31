# Marketplace Launch Evidence

Production stays landing/admin-support until a redacted Marketplace Launch Evidence packet passes verification and the production GitHub Environment is updated from that same packet. The packet is an operator-owned launch record summary; do not commit the live packet when it contains private provider references, buyer or seller data, screenshots, addresses, payment identifiers, or account identifiers.

## Verifier

Run the verifier from the repo root with a redacted packet:

```powershell
pnpm run marketplace:launch-evidence -- --file .\secure\redacted-marketplace-launch-evidence.json
```

The verifier fails closed when required approval gates are missing, references are placeholders, gate `checkedAt` timestamps are invalid, future-dated, or older than 30 days, GitHub Environment values drift from the packet, required workflow proof fields are missing, Tax posture contradicts collection readiness, launch supply has any active eligible listing without a resolved product measure, or UCP/AP2 public claims are enabled without certification.

When production approval variables are not set yet, assemble the first passing packet from gate outputs and an explicit desired production posture. Use `--launch-evidence-reference` for the private record or artifact that stores the passing redacted packet. Use `--public-enabled true` only for the final launch packet; keep it `false` for a pre-promotion rehearsal packet:

```powershell
pnpm run marketplace:launch-packet -- --public-enabled true --launch-evidence-reference MARKETPLACE-LAUNCH-EVIDENCE-2026-05-30 --launch-supply-reference CATALOG-MEASURES-2026-05-30 --promotion .\secure\marketplace-promotion-evidence-2026-05-30.json --checkout-fee .\secure\marketplace-checkout-fee-evidence-2026-05-30.json --stripe-money .\secure\stripe-money-operations-evidence-2026-05-30.json --support .\secure\support-operations-evidence-2026-05-30.json --fulfillment-postage .\secure\fulfillment-postage-evidence-2026-05-30.json --transactional-email .\secure\transactional-email-evidence-2026-05-30.json --launch-supply .\secure\launch-supply-measurement-2026-05-30.json --tax-readiness .\secure\tax-readiness-evidence-2026-05-30.json > .\secure\redacted-marketplace-launch-evidence.json
```

The assembler derives `productionEnvironment` approval and reference values from the gate outputs in this mode. It still validates the complete packet before printing it.

After updating production from a passing packet, export the production GitHub Environment variables, then convert them into the `productionEnvironment` object consumed by the drift-check packet:

```powershell
gh variable list --env production --json name,value > .\secure\github-production-variables-2026-05-30.json
pnpm run marketplace:production-env-snapshot -- --variables .\secure\github-production-variables-2026-05-30.json > .\secure\production-environment-2026-05-30.json
```

To avoid an intermediate file, pass the GitHub CLI output through stdin:

```powershell
gh variable list --env production --json name,value | pnpm run marketplace:production-env-snapshot -- --variables - > .\secure\production-environment-2026-05-30.json
```

To verify GitHub Environment drift after running the generated variable commands, assemble the packet again from the actual production environment snapshot:

```powershell
pnpm run marketplace:launch-packet -- --production-env .\secure\production-environment-2026-05-30.json --promotion .\secure\marketplace-promotion-evidence-2026-05-30.json --checkout-fee .\secure\marketplace-checkout-fee-evidence-2026-05-30.json --stripe-money .\secure\stripe-money-operations-evidence-2026-05-30.json --support .\secure\support-operations-evidence-2026-05-30.json --fulfillment-postage .\secure\fulfillment-postage-evidence-2026-05-30.json --transactional-email .\secure\transactional-email-evidence-2026-05-30.json --launch-supply .\secure\launch-supply-measurement-2026-05-30.json --tax-readiness .\secure\tax-readiness-evidence-2026-05-30.json
```

The assembler emits the exact packet consumed by `marketplace:launch-evidence` and immediately validates it. In drift-check mode, it normalizes the launch-supply measurement into `gates.launchSupplyMeasurements` using `PRODUCTION_LAUNCH_SUPPLY_MEASUREMENTS_REFERENCE` from the production environment snapshot and fails if any gate output or environment value drifts.

After the packet passes, generate the exact production GitHub Environment variable commands from that same packet:

```powershell
pnpm run marketplace:production-env-commands -- --file .\secure\redacted-marketplace-launch-evidence.json
```

Review the emitted commands against the private launch record, then run them from an authenticated `gh` shell. Do not hand-copy individual approval variables from separate gate outputs; use the passing packet as the single source of truth.

After setting the packet-derived variables and required secret names, run the final public launch preflight before triggering production promotion:

```powershell
gh variable list --env production --json name,value > .\secure\github-production-variables-2026-05-30.json
gh secret list --env production --json name,updatedAt > .\secure\github-production-secrets-2026-05-30.json
pnpm run marketplace:production-launch-readiness -- --variables .\secure\github-production-variables-2026-05-30.json --secrets .\secure\github-production-secrets-2026-05-30.json
```

The launch readiness preflight fails until public promotion is explicitly enabled from the passing packet, proof mode is off, every launch approval variable/reference is present and non-placeholder, Tax posture is explicit, `EASYPOST_MODE=production`, admin Google Workspace SSO is configured for `chasesets.com`, Amazon SES is configured for `transactional-production`, and live Stripe, EasyPost, SES, Google SSO, DigitalOcean, Spaces, and Platform secret names exist in the production GitHub Environment.

## Private Evidence Workspace

The live launch evidence record lives in a private Google Drive folder for the launch date. Use a folder name that includes the release commit and date, for example `Chase Sets Marketplace Launch Evidence - 2026-05-30 - f318fd3`. Keep provider screenshots, account identifiers, buyer and seller data, addresses, payment identifiers, tax workpapers, and dashboard exports in that private folder only.

Create these records before enabling the production marketplace switch:

- `00 Launch Review`: final promotion approval, release commit, production GitHub Environment export, passing verifier output, staging workflow run, production workflow run, rollback owner, and launch approver.
- `01 Payments Fee`: Marketplace Checkout Fee approval, live policy endpoint `200` observation, buyer-facing fee copy, state disclosure review, refund language, and Stripe live-mode fee configuration.
- `02 Stripe Money Operations`: live Stripe checkout, refund, dispute, Connect onboarding, payout schedule, payout hold, platform-balance funding, payout failure reversal, webhook replay, Radar/risk posture, and reconciliation evidence.
- `03 Fulfillment Postage`: EasyPost production mode, `/api/fulfillment/provider/postage/webhooks` destination, `fulfillment_postage_provider_events` proof, parcel label purchase, label void/refund, tracking event, delivery exception path, and Letter Mailpiece handling evidence.
- `04 Transactional Email`: Amazon SES DNS, production identity, controlled sends, outbox dispatch, `/api/notifications/provider/email/webhooks` event destination, `notification_email_provider_events` bounce/complaint rows, monitoring, and critical template coverage.
- `05 Launch Supply Measurements`: production query, raw redacted result, active checkout-eligible listing count, seller account count, sampled active listing IDs, missing-measure count, coverage percentage, operator, and timestamp.
- `06 Tax Readiness`: counsel/accounting approval, state-by-state nexus posture, collection-required jurisdiction list, provider decision, and `TAX_PROVIDER_BACKED_QUOTES_REQUIRED` value.
- `07 Support Operations`: account issue opening, admin queue review, overdue or urgent review, evidence/response/resolution/close/cancel endpoints, refund-producing resolution visibility, settlement hold coordination, and support notifications.
- `08 Public Presence`: launch-mode copy review for home, terms, privacy, refunds and returns, order protection, sales fee, FAQ, contact, and confirmation that no uncertified UCP/AP2/headless-checkout claims are live.

Use the Google Drive document URL or stable record identifier as each gate `reference`. The redacted packet may be kept locally under `secure/` while working; `secure/` is ignored because it can contain sensitive evidence summaries even when screenshots are excluded.

Build the Marketplace Promotion and UCP/AP2 Marketing gates from the final launch review record:

```powershell
pnpm run marketplace:promotion-evidence -- --review .\secure\marketplace-promotion-2026-05-30.json --reference LAUNCH-REVIEW-2026-05-30
```

The review JSON must include `reviewReference`, `reviewCompletedAt`, `environment: "production"`, `releaseCommit`, staging and production workflow run references, public presence and policy page review references, a launch-mode Public Presence copy audit reference with `publicPresenceCopyAuditVersion: "marketplace-public-presence-copy-audit/v1"`, `publicPresenceCopyAuditBaseUrl: "https://chasesets.com"`, `publicPresenceCopyAuditMode: "launch"`, `publicPresenceCopyAuditCompletedAt`, `publicPresenceCopyAuditRequiredPageCount: 8`, and true audit summary values for pass, future-only copy removal, policy-page reachability, and uncertified-claim absence. It must also include a rollback owner reference, true values for final launch review, public launch-copy review, future-only copy removal, policy-page review, and rollback ownership, plus explicit UCP/AP2 public-claim posture. Set `publicLaunchClaimsEnabled: false` and `uncertifiedClaimsAbsent: true` for the current launch unless a separate UCP/AP2 certification record exists. The command prints the fields that map into `gates.marketplacePromotion` and `gates.ucpAp2Marketing`, and the launch verifier rejects stale launch review, vague copy-audit summaries, or stale copy-audit evidence.

Build the Public Presence copy audit for the current production posture:

```powershell
pnpm run marketplace:public-presence-copy-audit -- --base-url https://chasesets.com --mode prelaunch
```

Use `--mode prelaunch` while `PRODUCTION_MARKETPLACE_PUBLIC_ENABLED=false`; it requires the public pages to stay explicit that checkout remains gated and rejects uncertified UCP/AP2/headless-checkout claims. Use `--mode launch` only during final promotion review; it fails while future-only launch copy such as early access, waitlist, or production-promotion-gated checkout language remains live.

Build the Marketplace Checkout Fee gate from the Payments-owned approval record:

```powershell
pnpm run marketplace:checkout-fee-evidence -- --approval .\secure\marketplace-checkout-fee-2026-05-30.json --reference PAYMENTS-FEE-2026-05-30
```

The approval JSON must include `approvalReference`, `approvalCompletedAt`, `environment: "production"`, `releaseCommit`, `feePolicyVersion: "marketplace-checkout-fee-v1"`, `feePolicyEffectiveAt`, `stripeMode: "live"`, the live policy endpoint URL `/api/marketplace/account/marketplace-checkout-fee-policy` on a production Chase Sets host, HTTP status `200`, endpoint checked-at timestamp, the live policy endpoint reference, the approved live policy snapshot (`enabledJurisdictions: ["US"]`, card/base `290` bps plus `0.30`, bank-account `50` bps plus `0.00`, platform-credit `0` bps plus `0.00`, `unsupportedMethodsDefault: "no-positive-fee"`, and stale quote handling `409 fee_quote_stale` with confirmation required), references for buyer-facing copy, fee labels, refund language, state disclosure review, and Stripe live fee configuration, plus true approval values for those five launch requirements. The command prints the fields that map into `gates.marketplaceCheckoutFee`, and the launch verifier rejects stale fee approval evidence, missing production endpoint observations, or a policy snapshot that does not match the live Payments endpoint.

Build the Stripe Money Operations gate from the live proof record:

```powershell
pnpm run marketplace:stripe-money-operations-evidence -- --proof .\secure\stripe-money-operations-2026-05-30.json --reference STRIPE-MONEY-2026-05-30
```

The proof JSON must include `proofReference`, `proofCompletedAt`, `environment: "live"`, `releaseCommit`, `apiVersion: "2026-02-25.clover"`, `paymentWebhookDestination`, `connectWebhookDestination`, `connectReturnUrl`, `connectRefreshUrl`, `connectConnectedAccountCount`, `paymentProviderEventRowCount` of at least `5`, `connectProviderEventRowCount` of at least `2`, concrete live Stripe object IDs (`livePaymentIntentId`, `liveCheckoutSessionId`, `refundId`, `disputeId`, `connectAccountId`, `payoutReadinessAccountId`, `payoutFailurePayoutId`, `payoutFailureBalanceTransactionId`, `platformFundingBalanceTransactionId`), `paymentProviderEventIds` with at least five concrete `evt_` IDs, `connectProviderEventIds` with at least two concrete `evt_` IDs, concrete references for live checkout, refund, dispute, Connect onboarding, payout readiness, payout failure reversal, reconciliation, platform balance funding, webhook replay, Payments provider event query, Settlement money-movement provider event query, and Radar/risk posture, plus true values for each of those workflows. The command prints the fields that map into `gates.stripeMoneyOperations`, and the launch verifier rejects Stripe money gates that only provide booleans, a generic proof link, stale live proof, or missing Stripe object and provider-event IDs.

During private production proof mode, register Stripe payment webhooks to `/api/payments/provider/webhooks` and Stripe Connect money-movement webhooks to `/api/settlement/provider/money-movement/webhooks` on the production root or admin domain. These provider callback paths route to `platform-api` while broad public/admin `/api/*` traffic remains on admin-support until `PRODUCTION_MARKETPLACE_PUBLIC_ENABLED=true`. Proof mode also routes narrow authenticated Checkout, Ordering, Payments, and Settlement proof APIs to `platform-api` so operators can create deferred checkout orders, live payment, refund, payout-readiness, payout, reconciliation, and provider-health evidence without opening the public marketplace.

Build the Fulfillment Postage gate from the production EasyPost proof record:

```powershell
pnpm run marketplace:fulfillment-postage-evidence -- --proof .\secure\fulfillment-postage-2026-05-30.json --reference FULFILLMENT-POSTAGE-2026-05-30
```

The proof JSON must include `proofReference`, `proofCompletedAt`, `environment: "production"`, `releaseCommit`, `easyPostMode: "production"`, `webhookDestination`, `providerEventRowCount` of at least `4`, `matchedShipmentProviderEventRowCount` of at least `4`, `trackingStatusProviderEventRowCount` of at least `3`, `refundStatusProviderEventRowCount` of at least `1`, concrete EasyPost and Fulfillment identifiers (`controlledParcelShipmentId`, `parcelProviderShipmentId`, `parcelProviderLabelId`, `trackingProviderObjectReference`, `trackingIdentifier`, `deliveryExceptionProviderEventId`, `labelVoidRefundProviderObjectReference`, `letterMailpieceShipmentId`), `providerEventIds` with at least four concrete EasyPost `evt_` IDs, `trackingStatusProviderEventIds` with at least three concrete EasyPost `evt_` IDs, `refundStatusProviderEventIds` with at least one concrete EasyPost `evt_` ID, concrete references for the EasyPost account, webhook destination, provider event query, parcel label purchase, label void/refund, tracking event, delivery exception, and Letter Mailpiece rehearsal, plus true values for EasyPost production mode, webhook destination configuration, provider event rows, parcel label purchase, label void/refund, tracking event processing, delivery exception handling, and Letter Mailpiece handling. The launch packet assembler copies this proof into production environment as `EASYPOST_MODE=production`; it refuses to derive launch variables from non-production EasyPost proof. The command prints the fields that map into `gates.fulfillmentPostage`, and the launch verifier rejects stale production postage proof or missing EasyPost object and provider-event IDs.

Build the Transactional Email gate from the production SES proof record:

```powershell
pnpm run marketplace:transactional-email-evidence -- --proof .\secure\transactional-email-2026-05-30.json --reference NOTIFICATIONS-SES-2026-05-30
```

The proof JSON must include `proofReference`, `proofCompletedAt`, `environment: "production"`, `releaseCommit`, `sesConfigurationSetName: "transactional-production"`, `webhookDestination`, `providerEventRowCount`, `controlledSendProviderMessageId`, `outboxRowId`, `deliveryProviderEventId`, `bounceProviderEventId`, `complaintProviderEventId`, true values for SES DNS, controlled send, outbox dispatch, SNS subscription confirmation, bounce/complaint parsing, delivery monitoring, and webhook destination configuration, concrete references for SES identity verification, controlled send message, outbox dispatch, delivery event, bounce event, complaint event, delivery monitoring, SNS subscription confirmation, and template review evidence, plus critical template coverage for auth, orders, payments, fulfillment, refunds, support, and payouts. Provider event IDs must use the `amazon-ses:<message-id>:delivery|bounce|complaint:<occurred-at>` shape from `notification_email_provider_events.provider_event_id`. The command prints the fields that map into `gates.transactionalEmail`, and the launch verifier rejects stale production email proof or missing SES message/outbox/provider-event identifiers.

Build the Support Operations gate from the staging rehearsal record:

```powershell
pnpm run marketplace:support-operations-evidence -- --rehearsal .\secure\support-operations-rehearsal-2026-05-30.json --reference SUPPORT-OPS-2026-05-30
```

The rehearsal JSON must include `rehearsalReference`, `rehearsalCompletedAt`, `environment: "staging"`, `releaseCommit`, true values for buyer issue opening, seller issue opening, operations queue review, overdue escalation, lifecycle endpoints, refund-producing resolution, settlement hold coordination, and support notifications, plus the buyer `sup_` support request id, seller `sup_` support request id, refund-resolution `sup_` support request id, Payments `sre_` refund effect id, Payments `rfd_` refund id, Settlement `hold_` hold id, operations queue review reference, overdue escalation result reference, lifecycle endpoint result reference, Payments refund-effect evidence, Settlement hold evidence, separate Settlement hold-release evidence, and support notification evidence. The command prints the fields that map into `gates.supportOperations`, and the launch verifier rejects support gates that only provide booleans, reuse the hold evidence as the release evidence, use wrong bounded-context id prefixes, or carry stale rehearsal evidence.

## Packet Shape

Use `schemaVersion: "marketplace-launch-evidence/v1"` and `environment: "production"`. Keep `PRODUCTION_MARKETPLACE_PUBLIC_ENABLED=false` until the packet passes and the final launch review approves promotion.

Required `gates` keys:

- `marketplacePromotion`
- `marketplaceCheckoutFee`
- `stripeMoneyOperations`
- `supportOperations`
- `fulfillmentPostage`
- `transactionalEmail`
- `launchSupplyMeasurements`
- `taxReadiness`
- `ucpAp2Marketing`

Each approval gate carries `approved`, `reference`, `owner`, and `checkedAt`. References must point to real external launch records, not placeholders. High-risk gates also carry redacted proof booleans and supporting references so a packet cannot pass with only a generic approval link. Every release-scoped gate must use the same 40-character Git commit SHA in `releaseCommit` as the Marketplace Promotion gate; do not mix staging rehearsal, provider proof, or copy approval records from different builds. `productionEnvironment` mirrors the GitHub Environment values that will be set for promotion and must include `PRODUCTION_MARKETPLACE_LAUNCH_EVIDENCE_REFERENCE` pointing to the passing packet record.

Production provider proof may be collected before public launch with `PRODUCTION_MARKETPLACE_PROOF_ENABLED=true` and a non-empty `PRODUCTION_MARKETPLACE_PROOF_REFERENCE`. That deploys the production platform API, worker, and commerce databases for evidence collection while `PRODUCTION_MARKETPLACE_PUBLIC_ENABLED=false` keeps marketplace web and marketplace domain routing closed. Do not treat proof mode as launch approval; the launch packet and production approval variables below still must pass before public promotion.

Before enabling proof mode, export the production GitHub Environment variable and secret-name lists and run the private proof readiness preflight:

```powershell
gh variable list --env production --json name,value > .\secure\github-production-variables-2026-05-30.json
gh secret list --env production --json name,updatedAt > .\secure\github-production-secrets-2026-05-30.json
pnpm run marketplace:production-proof-readiness -- --variables .\secure\github-production-variables-2026-05-30.json --secrets .\secure\github-production-secrets-2026-05-30.json
```

For a one-off local check, either input can be piped through stdin with `-`; keep the variables and secret-name exports separate so the preflight can distinguish values from secret names.

The preflight fails until production has `PRODUCTION_MARKETPLACE_PUBLIC_ENABLED=false`, `PRODUCTION_MARKETPLACE_PROOF_ENABLED=true`, a real `PRODUCTION_MARKETPLACE_PROOF_REFERENCE`, Amazon SES transactional variables, live Stripe secret names, EasyPost production key and webhook secret names, SES secret names, Google Workspace admin SSO variables and secret names, and the baseline DigitalOcean/Spaces/admin-support secret names required by deployment.

When the preflight fails, use `operatorSetup.variableCommands` and `operatorSetup.secretCommands` from the JSON output as the production setup checklist. The secret commands are name-only and must be run interactively or from a private password manager so secret values never appear in launch evidence or repository files.

The readiness output also includes `providerCallbackSetup.dashboardDestinations`, which is the exact provider-dashboard setup manifest for private proof mode. Configure Stripe payment webhooks, Stripe Connect money-movement webhooks, SES/SNS notifications, and EasyPost webhooks from those URLs only after the topology evidence command confirms they return expected JSON API responses from the production proof origin, with provider callbacks handled as accepted or malformed callback requests and private proof APIs returning unauthenticated JSON challenges. Use `operatorSetup.sesSnsEventDestinationSetup` for the AWS SNS topic/subscription and SES configuration-set event destination commands, and use `operatorSetup.easyPostWebhookSetup` as the EasyPost dashboard checklist before collecting Transactional Email or Fulfillment Postage proof. `providerCallbackSetup.stripeConnectOnboarding` carries private proof return/refresh URLs on the proof API origin for live smoke tests, plus final launch return/refresh URLs on the marketplace domain for the Stripe money operations launch evidence. Use `operatorSetup.stripeMoneySmokeEnvironmentCommands` to prepare the private live Stripe smoke shell after topology evidence passes and the live Stripe secrets are loaded, choose one `operatorSetup.stripeMoneySmokeAuthenticationOptions` entry for the authenticated seller-flow session, then run `operatorSetup.stripeMoneySmokeCheckCommand` before the live smoke command. Continue only when the check output has `"ok": true` and an empty `readinessErrors` array.

Use `pnpm run marketplace:production-proof-topology-evidence` after enabling proof mode and before configuring provider dashboards. The command proves the base URL is `https://chasesets.com` or `https://admin.chasesets.com`, the production health endpoint returns JSON `200`, Stripe payment, Stripe Connect money-movement, SES/SNS email, and EasyPost postage callback paths return JSON `200` or `400` without redirects, the exact private Checkout/Ordering/Payments/Settlement proof APIs used by live money smoke and deferred-checkout order creation return JSON `401` without redirects, proof mode is explicitly enabled, and public marketplace promotion remains disabled.

```json
{
  "schemaVersion": "marketplace-launch-evidence/v1",
  "environment": "production",
  "productionEnvironment": {
    "PRODUCTION_MARKETPLACE_PUBLIC_ENABLED": "false",
    "PRODUCTION_MARKETPLACE_LAUNCH_EVIDENCE_REFERENCE": "MARKETPLACE-LAUNCH-EVIDENCE-2026-05-30",
    "PRODUCTION_MARKETPLACE_PROOF_ENABLED": "false",
    "PRODUCTION_MARKETPLACE_PROOF_REFERENCE": "",
    "PRODUCTION_MARKETPLACE_PROMOTION_APPROVED": "true",
    "PRODUCTION_MARKETPLACE_PROMOTION_REFERENCE": "LAUNCH-REVIEW-2026-05-30",
    "PRODUCTION_MARKETPLACE_CHECKOUT_FEE_APPROVED": "true",
    "PRODUCTION_MARKETPLACE_CHECKOUT_FEE_REFERENCE": "PAYMENTS-FEE-2026-05-30",
    "PRODUCTION_STRIPE_MONEY_OPERATIONS_APPROVED": "true",
    "PRODUCTION_STRIPE_MONEY_OPERATIONS_REFERENCE": "STRIPE-MONEY-2026-05-30",
    "PRODUCTION_SUPPORT_OPERATIONS_APPROVED": "true",
    "PRODUCTION_SUPPORT_OPERATIONS_REFERENCE": "SUPPORT-OPS-2026-05-30",
    "PRODUCTION_FULFILLMENT_POSTAGE_APPROVED": "true",
    "PRODUCTION_FULFILLMENT_POSTAGE_REFERENCE": "FULFILLMENT-POSTAGE-2026-05-30",
    "PRODUCTION_TRANSACTIONAL_EMAIL_APPROVED": "true",
    "PRODUCTION_TRANSACTIONAL_EMAIL_REFERENCE": "NOTIFICATIONS-SES-2026-05-30",
    "PRODUCTION_LAUNCH_SUPPLY_MEASUREMENTS_APPROVED": "true",
    "PRODUCTION_LAUNCH_SUPPLY_MEASUREMENTS_REFERENCE": "CATALOG-MEASURES-2026-05-30",
    "PRODUCTION_TAX_READINESS_APPROVED": "true",
    "PRODUCTION_TAX_READINESS_REFERENCE": "TAX-READINESS-2026-05-30",
    "TAX_PROVIDER_BACKED_QUOTES_REQUIRED": "false"
  },
  "gates": {
    "marketplacePromotion": {
      "approved": true,
      "reference": "LAUNCH-REVIEW-2026-05-30",
      "owner": "Platform",
      "checkedAt": "2026-05-30T11:00:00.000Z",
      "reviewReference": "LAUNCH-REVIEW-PROOF-2026-05-30",
      "reviewCompletedAt": "2026-05-30T10:10:00.000Z",
      "environment": "production",
      "finalLaunchReviewApproved": true,
      "publicPresenceLaunchCopyReviewed": true,
      "futureOnlyLaunchCopyRemoved": true,
      "policyPagesReviewed": true,
      "rollbackOwnerAssigned": true,
      "releaseCommit": "f318fd3577b635959dabc23117f509ed45621268",
      "stagingWorkflowRunReference": "platform-deploy-staging-26688444710",
      "productionWorkflowRunReference": "platform-deploy-production-26688444710",
      "publicPresenceReviewReference": "PUBLIC-PRESENCE-LAUNCH-COPY-2026-05-30",
      "publicPresenceCopyAuditReference": "PUBLIC-PRESENCE-COPY-AUDIT-2026-05-30",
      "publicPresenceCopyAuditVersion": "marketplace-public-presence-copy-audit/v1",
      "publicPresenceCopyAuditBaseUrl": "https://chasesets.com",
      "publicPresenceCopyAuditCompletedAt": "2026-05-30T10:00:00.000Z",
      "publicPresenceCopyAuditMode": "launch",
      "publicPresenceCopyAuditRequiredPageCount": 8,
      "publicPresenceCopyAuditPassed": true,
      "publicPresenceCopyAuditFutureOnlyLaunchCopyRemoved": true,
      "publicPresenceCopyAuditPolicyPagesReviewed": true,
      "publicPresenceCopyAuditUncertifiedClaimsAbsent": true,
      "policyPagesReviewReference": "PUBLIC-POLICY-PAGES-2026-05-30",
      "rollbackOwnerReference": "ROLLBACK-OWNER-2026-05-30"
    },
    "marketplaceCheckoutFee": {
      "approved": true,
      "reference": "PAYMENTS-FEE-2026-05-30",
      "owner": "Payments",
      "checkedAt": "2026-05-30T11:00:00.000Z",
      "approvalReference": "PAYMENTS-FEE-APPROVAL-2026-05-30",
      "approvalCompletedAt": "2026-05-30T10:20:00.000Z",
      "environment": "production",
      "releaseCommit": "f318fd3577b635959dabc23117f509ed45621268",
      "feePolicyVersion": "marketplace-checkout-fee-v1",
      "feePolicyEffectiveAt": "2026-05-03T00:00:00.000Z",
      "enabledJurisdictions": ["US"],
      "basePercentageBps": 290,
      "baseFixedAmount": "0.30",
      "bankAccountResultingPercentageBps": 50,
      "bankAccountResultingFixedAmount": "0.00",
      "platformCreditResultingPercentageBps": 0,
      "platformCreditResultingFixedAmount": "0.00",
      "unsupportedMethodsDefault": "no-positive-fee",
      "feeQuoteConfirmationRequired": true,
      "feeQuoteStaleResponseCode": 409,
      "feeQuoteStaleResponseError": "fee_quote_stale",
      "stripeMode": "live",
      "livePolicyEndpointUrl": "https://chasesets.com/api/marketplace/account/marketplace-checkout-fee-policy",
      "livePolicyEndpointStatusCode": 200,
      "livePolicyEndpointCheckedAt": "2026-05-30T10:18:00.000Z",
      "livePolicyEndpointReference": "PAYMENTS-FEE-POLICY-ENDPOINT-2026-05-30",
      "buyerFacingCopyReference": "PAYMENTS-FEE-COPY-2026-05-30",
      "feeLabelsReference": "PAYMENTS-FEE-LABELS-2026-05-30",
      "refundLanguageReference": "PAYMENTS-FEE-REFUNDS-2026-05-30",
      "stateDisclosureReviewReference": "PAYMENTS-FEE-STATE-DISCLOSURES-2026-05-30",
      "stripeLiveFeeConfigurationReference": "STRIPE-LIVE-FEE-CONFIG-2026-05-30",
      "buyerFacingCopyApproved": true,
      "feeLabelsApproved": true,
      "refundLanguageApproved": true,
      "stateDisclosureReviewApproved": true,
      "stripeLiveFeeConfigurationApproved": true
    },
    "stripeMoneyOperations": {
      "approved": true,
      "reference": "STRIPE-MONEY-2026-05-30",
      "owner": "Payments and Settlement",
      "checkedAt": "2026-05-30T11:00:00.000Z",
      "proofReference": "STRIPE-MONEY-PROOF-2026-05-30",
      "proofCompletedAt": "2026-05-30T10:25:00.000Z",
      "environment": "live",
      "releaseCommit": "f318fd3577b635959dabc23117f509ed45621268",
      "apiVersion": "2026-02-25.clover",
      "paymentWebhookDestination": "https://marketplace.chasesets.com/api/payments/provider/webhooks",
      "connectWebhookDestination": "https://marketplace.chasesets.com/api/settlement/provider/money-movement/webhooks",
      "connectReturnUrl": "https://marketplace.chasesets.com/account/payouts",
      "connectRefreshUrl": "https://marketplace.chasesets.com/account/payouts/setup",
      "connectConnectedAccountCount": 1,
      "paymentProviderEventRowCount": 5,
      "connectProviderEventRowCount": 2,
      "livePaymentIntentId": "pi_liveCheckout20260530",
      "liveCheckoutSessionId": "cs_liveCheckout20260530",
      "refundId": "re_liveRefund20260530",
      "disputeId": "dp_liveDispute20260530",
      "connectAccountId": "acct_liveSeller20260530",
      "payoutReadinessAccountId": "acct_liveSeller20260530",
      "payoutFailurePayoutId": "po_liveFailure20260530",
      "payoutFailureBalanceTransactionId": "txn_payoutFailure20260530",
      "platformFundingBalanceTransactionId": "txn_platformFunding20260530",
      "paymentProviderEventIds": [
        "evt_paymentCheckout2026053001",
        "evt_paymentIntent2026053002",
        "evt_paymentRefund2026053003",
        "evt_paymentDispute2026053004",
        "evt_paymentWebhookReplay2026053005"
      ],
      "connectProviderEventIds": [
        "evt_connectAccount2026053001",
        "evt_connectPayout2026053002"
      ],
      "liveCheckoutReference": "STRIPE-LIVE-CHECKOUT-2026-05-30",
      "refundReference": "STRIPE-REFUND-2026-05-30",
      "disputeReference": "STRIPE-DISPUTE-2026-05-30",
      "connectOnboardingReference": "STRIPE-CONNECT-ONBOARDING-2026-05-30",
      "payoutReadinessReference": "STRIPE-PAYOUT-READINESS-2026-05-30",
      "payoutFailureReversalReference": "STRIPE-PAYOUT-FAILURE-REVERSAL-2026-05-30",
      "reconciliationReference": "STRIPE-RECONCILIATION-2026-05-30",
      "platformBalanceFundingReference": "STRIPE-PLATFORM-BALANCE-2026-05-30",
      "webhookReplayReference": "STRIPE-WEBHOOK-REPLAY-2026-05-30",
      "paymentProviderEventQueryReference": "PAYMENTS-PROVIDER-WEBHOOK-EVENTS-2026-05-30",
      "connectProviderEventQueryReference": "SETTLEMENT-MONEY-MOVEMENT-WEBHOOK-EVENTS-2026-05-30",
      "radarRiskPostureReference": "STRIPE-RADAR-RISK-2026-05-30",
      "liveCheckoutProven": true,
      "refundProven": true,
      "disputeProven": true,
      "connectOnboardingProven": true,
      "payoutReadinessProven": true,
      "payoutFailureReversalProven": true,
      "reconciliationProven": true,
      "platformBalanceFundingProven": true,
      "webhookReplayProven": true,
      "radarRiskPostureApproved": true
    },
    "supportOperations": {
      "approved": true,
      "reference": "SUPPORT-OPS-2026-05-30",
      "owner": "Support",
      "checkedAt": "2026-05-30T11:00:00.000Z",
      "rehearsalReference": "SUPPORT-REHEARSAL-2026-05-30",
      "rehearsalCompletedAt": "2026-05-30T10:45:00.000Z",
      "environment": "staging",
      "releaseCommit": "f318fd3577b635959dabc23117f509ed45621268",
      "buyerSupportRequestId": "sup_buyer_rehearsal_20260530",
      "sellerSupportRequestId": "sup_seller_rehearsal_20260530",
      "operationsQueueReviewReference": "SUPPORT-QUEUE-REVIEW-2026-05-30",
      "overdueEscalationResultReference": "SUPPORT-OVERDUE-ESCALATION-2026-05-30",
      "lifecycleEndpointResultReference": "SUPPORT-LIFECYCLE-ENDPOINTS-2026-05-30",
      "refundResolutionSupportRequestId": "sup_buyer_rehearsal_20260530",
      "refundEffectId": "sre_buyer_rehearsal_20260530",
      "refundId": "rfd_support_rehearsal_20260530",
      "refundEffectReference": "PAYMENTS-SUPPORT-REFUND-EFFECT-2026-05-30",
      "settlementHoldId": "hold_support_rehearsal_20260530",
      "settlementHoldReference": "SETTLEMENT-SUPPORT-HOLD-2026-05-30",
      "settlementHoldReleaseReference": "SETTLEMENT-SUPPORT-HOLD-RELEASE-2026-05-30",
      "supportNotificationReference": "NOTIFICATIONS-SUPPORT-2026-05-30",
      "buyerIssueOpeningProven": true,
      "sellerIssueOpeningProven": true,
      "operationsQueueReviewProven": true,
      "overdueEscalationProven": true,
      "lifecycleEndpointsProven": true,
      "refundProducingResolutionProven": true,
      "settlementHoldCoordinationProven": true,
      "supportNotificationsProven": true
    },
    "fulfillmentPostage": {
      "approved": true,
      "reference": "FULFILLMENT-POSTAGE-2026-05-30",
      "owner": "Fulfillment",
      "checkedAt": "2026-05-30T11:00:00.000Z",
      "proofReference": "FULFILLMENT-POSTAGE-PROOF-2026-05-30",
      "proofCompletedAt": "2026-05-30T10:35:00.000Z",
      "environment": "production",
      "releaseCommit": "f318fd3577b635959dabc23117f509ed45621268",
      "easyPostMode": "production",
      "webhookDestination": "https://marketplace.chasesets.com/api/fulfillment/provider/postage/webhooks",
      "providerEventRowCount": 4,
      "matchedShipmentProviderEventRowCount": 4,
      "trackingStatusProviderEventRowCount": 3,
      "refundStatusProviderEventRowCount": 1,
      "controlledParcelShipmentId": "ship_controlled_parcel_20260530",
      "parcelProviderShipmentId": "shp_controlledParcel20260530",
      "parcelProviderLabelId": "pl_controlledParcel20260530",
      "trackingProviderObjectReference": "trk_controlledParcel20260530",
      "trackingIdentifier": "9400111202555012345678",
      "deliveryExceptionProviderEventId": "evt_deliveryException20260530",
      "labelVoidRefundProviderObjectReference": "rfnd_labelVoid20260530",
      "letterMailpieceShipmentId": "ship_letter_mailpiece_20260530",
      "providerEventIds": [
        "evt_trackingPreTransit20260530",
        "evt_trackingInTransit20260530",
        "evt_trackingException20260530",
        "evt_refundStatus20260530"
      ],
      "trackingStatusProviderEventIds": [
        "evt_trackingPreTransit20260530",
        "evt_trackingInTransit20260530",
        "evt_trackingException20260530"
      ],
      "refundStatusProviderEventIds": [
        "evt_refundStatus20260530"
      ],
      "easyPostAccountReference": "EASYPOST-ACCOUNT-2026-05-30",
      "webhookDestinationReference": "EASYPOST-WEBHOOK-DESTINATION-2026-05-30",
      "providerEventQueryReference": "FULFILLMENT-POSTAGE-PROVIDER-EVENTS-2026-05-30",
      "parcelLabelReference": "EASYPOST-LABEL-PURCHASE-2026-05-30",
      "labelVoidRefundReference": "EASYPOST-LABEL-VOID-REFUND-2026-05-30",
      "trackingEventReference": "EASYPOST-TRACKING-EVENT-2026-05-30",
      "deliveryExceptionReference": "EASYPOST-DELIVERY-EXCEPTION-2026-05-30",
      "letterMailpieceReference": "LETTER-MAILPIECE-HANDLING-2026-05-30",
      "easyPostProductionModeProven": true,
      "webhookDestinationConfigured": true,
      "providerEventRowsProven": true,
      "parcelLabelPurchaseProven": true,
      "labelVoidRefundProven": true,
      "trackingEventProven": true,
      "deliveryExceptionProven": true,
      "letterMailpieceHandlingProven": true
    },
    "transactionalEmail": {
      "approved": true,
      "reference": "NOTIFICATIONS-SES-2026-05-30",
      "owner": "Notifications",
      "checkedAt": "2026-05-30T11:00:00.000Z",
      "proofReference": "NOTIFICATIONS-SES-PROOF-2026-05-30",
      "proofCompletedAt": "2026-05-30T10:40:00.000Z",
      "environment": "production",
      "releaseCommit": "f318fd3577b635959dabc23117f509ed45621268",
      "sesConfigurationSetName": "transactional-production",
      "webhookDestination": "https://marketplace.chasesets.com/api/notifications/provider/email/webhooks",
      "providerEventRowCount": 3,
      "controlledSendProviderMessageId": "ses_msg_controlled_20260530",
      "outboxRowId": "42",
      "deliveryProviderEventId": "amazon-ses:ses_msg_controlled_20260530:delivery:2026-05-30T10:51:00.000Z",
      "bounceProviderEventId": "amazon-ses:ses_msg_bounce_20260530:bounce:2026-05-30T10:52:00.000Z",
      "complaintProviderEventId": "amazon-ses:ses_msg_complaint_20260530:complaint:2026-05-30T10:53:00.000Z",
      "sesIdentityReference": "SES-IDENTITY-CHASESETS-COM-2026-05-30",
      "controlledSendMessageReference": "SES-MESSAGE-CONTROLLED-SEND-2026-05-30",
      "outboxDispatchReference": "NOTIFICATION-OUTBOX-DISPATCH-2026-05-30",
      "deliveryEventReference": "SES-DELIVERY-EVENT-2026-05-30",
      "bounceEventReference": "SES-BOUNCE-EVENT-2026-05-30",
      "complaintEventReference": "SES-COMPLAINT-EVENT-2026-05-30",
      "deliveryMonitoringReference": "SES-MONITORING-2026-05-30",
      "snsSubscriptionConfirmationReference": "SNS-SUBSCRIPTION-CONFIRMATION-2026-05-30",
      "templateReviewReference": "TRANSACTIONAL-TEMPLATE-REVIEW-2026-05-30",
      "sesDnsVerified": true,
      "controlledSendProven": true,
      "outboxDispatchProven": true,
      "bounceComplaintParsingProven": true,
      "deliveryMonitoringProven": true,
      "webhookDestinationConfigured": true,
      "snsSubscriptionConfirmed": true,
      "criticalTemplateAreasCovered": ["auth", "orders", "payments", "fulfillment", "refunds", "support", "payouts"]
    },
    "launchSupplyMeasurements": {
      "approved": true,
      "reference": "CATALOG-MEASURES-2026-05-30",
      "owner": "Catalog",
      "checkedAt": "2026-05-30T11:00:00.000Z",
      "queryVersion": "launch-supply-measurement-query/v1",
      "environment": "production",
      "activeLaunchListingCount": 42,
      "activeLaunchSellerAccountCount": 7,
      "sampledActiveLaunchListingIds": ["lst_1", "lst_2", "lst_3"],
      "activeLaunchListingsMissingResolvedProductMeasures": 0,
      "resolvedProductMeasureCoveragePercent": 100,
      "queryReference": "launch-supply-measurement-query-2026-05-30",
      "operator": "ops@chasesets.com",
      "projectionFreshnessReference": "projection-freshness-2026-05-30"
    },
    "taxReadiness": {
      "approved": true,
      "reference": "TAX-READINESS-2026-05-30",
      "owner": "Tax",
      "checkedAt": "2026-05-30T11:00:00.000Z",
      "posture": "no_collection_required",
      "collectionRequiredJurisdictions": [],
      "taxProviderBackedQuotesRequired": false,
      "providerBackedResolverComposed": false,
      "counselAccountingApprovalReference": "tax-counsel-2026-05-30",
      "stateByStateNexusReference": "tax-nexus-2026-05-30",
      "providerDecisionReference": "tax-provider-decision-2026-05-30",
      "thresholdPolicyReference": "tax-threshold-policy-2026-05-30",
      "nexusMonitoringReference": "tax-nexus-monitoring-2026-05-30",
      "nexusReportAsOf": "2026-05-30T10:30:00.000Z",
      "sourceMeasurementReference": "TAX-NEXUS-SOURCE-2026-05-30",
      "sourceMeasurementEnvironment": "production",
      "sourceMeasurementQueryVersion": "tax-nexus-measurement-query/v1",
      "sourceMeasurementCheckedAt": "2026-05-30T10:20:00.000Z",
      "sourceMeasurementProjectionFreshnessReference": "ORDERING-PROJECTION-FRESHNESS-2026-05-30",
      "sourceMeasurementQueryWindow": {
        "previousYearStart": "2025-01-01T00:00:00.000Z",
        "currentYearStart": "2026-01-01T00:00:00.000Z",
        "nextYearStart": "2027-01-01T00:00:00.000Z"
      },
      "sourceMeasurementJurisdictionCount": 51,
      "sourceMeasurementMissingJurisdictionOrderCount": 0,
      "sourceMeasurementUnknownJurisdictionOrderCount": 0,
      "sourceMeasurementRequiresManualReview": false,
      "sourceMeasurementPasses": true,
      "stateByStateJurisdictionReviewCount": 51,
      "providerBackedQuotesMissing": false,
      "registrationRequiredJurisdictions": [],
      "preparationJurisdictions": [],
      "manualReviewJurisdictions": ["AK", "CO", "LA"]
    },
    "ucpAp2Marketing": {
      "owner": "Checkout and Payments",
      "publicLaunchClaimsEnabled": false,
      "certificationApproved": false,
      "certificationReference": ""
    }
  }
}
```

## Launch Supply Measurement Sweep

Run this against the production marketplace read models after projections are caught up. `--query-reference` must point to the production query evidence record; `queryVersion` already carries the canonical SQL version and cannot stand in for evidence. The command fails closed unless active launch listings are present, at least one active seller account is represented, sampled production listing IDs are included, missing resolved measures equal `0`, coverage is `100`, the environment is `production`, `checkedAt` is an ISO timestamp, the operator is present, and both query and projection-freshness references are real evidence records. It prints the redacted measurement fields that map into `gates.launchSupplyMeasurements`; keep the production database URL out of the evidence packet and attach the JSON output, production environment, production query record, projection freshness record, timestamp, operator identity, and redacted listing sample support to `PRODUCTION_LAUNCH_SUPPLY_MEASUREMENTS_REFERENCE`.

```powershell
pnpm run marketplace:launch-supply-measurement -- --environment production --operator ops@chasesets.com --query-reference CATALOG-LAUNCH-SUPPLY-QUERY-2026-05-30 --projection-freshness-reference PROJECTION-FRESHNESS-2026-05-30
```

Use `MARKETPLACE_DATABASE_URL` or `DATABASE_URL` for the production read-model connection and set `--environment production` or `LAUNCH_SUPPLY_ENVIRONMENT=production`. If an operator needs a one-off shell, `--database-url` is supported, but avoid recording the value in tickets, docs, or evidence folders. The command emits the canonical query version `launch-supply-measurement-query/v1` separately from the required launch-specific external query record.

```sql
WITH active_holds AS (
  SELECT item_id, SUM(quantity)::integer AS held_quantity
  FROM marketplace_supply_holds
  WHERE status = 'active'
  GROUP BY item_id
),
eligible_listings AS (
  SELECT
    listing.listing_id,
    listing.account_id,
    listing.product_measure_snapshot
  FROM marketplace_listing_pages AS listing
  INNER JOIN marketplace_supply_items AS item
    ON item.item_id = listing.inventory_item_id
  LEFT JOIN active_holds
    ON active_holds.item_id = item.item_id
  LEFT JOIN marketplace_seller_listing_availability_pages AS availability
    ON availability.account_id = listing.account_id
  WHERE listing.status = 'active'
    AND COALESCE(availability.status, 'available') = 'available'
    AND LEAST(
      listing.quantity_cap,
      GREATEST(item.total_quantity - COALESCE(active_holds.held_quantity, 0), 0)
    ) > 0
)
SELECT
  COUNT(*)::integer AS active_launch_listing_count,
  COUNT(DISTINCT account_id)::integer AS active_launch_seller_account_count,
  COALESCE(
    (
      SELECT ARRAY_AGG(sampled.listing_id ORDER BY sampled.listing_id)
      FROM (
        SELECT listing_id
        FROM eligible_listings
        WHERE product_measure_snapshot IS NOT NULL
        ORDER BY listing_id
        LIMIT 10
      ) AS sampled
    ),
    ARRAY[]::text[]
  ) AS sampled_active_launch_listing_ids,
  COUNT(*) FILTER (WHERE product_measure_snapshot IS NULL)::integer
    AS active_launch_listings_missing_resolved_product_measures,
  CASE
    WHEN COUNT(*) = 0 THEN 0
    ELSE ROUND(
      100.0
      * COUNT(*) FILTER (WHERE product_measure_snapshot IS NOT NULL)
      / COUNT(*),
      2
    )
  END::numeric AS resolved_product_measure_coverage_percent
FROM eligible_listings;
```

The packet passes only when the active listing count and seller account count are greater than zero, sampled listing IDs are concrete and distinct, missing measurements are zero, and coverage is exactly `100`.

## Tax Posture

Build the source activity measurement from production order tax snapshots before producing the approved Tax gate. Keep the full counsel/accounting workpapers and any state-level raw sales exports in the private evidence folder.

```powershell
pnpm run marketplace:tax-nexus-measurement -- --database-url $env:PRODUCTION_DATABASE_URL --environment production --operator "ops@chasesets.com" --projection-freshness-reference ORDERING-PROJECTION-2026-05-30 --reference TAX-NEXUS-SOURCE-2026-05-30
```

The measurement command prints redacted state-by-state activity for the current and previous calendar years. It fails unless the measurement is explicitly production-scoped, `checkedAt` is an ISO timestamp, the operator is present, the source measurement and projection-freshness references are real evidence records, the query window is internally consistent, every Tax-supported US jurisdiction is represented in the redacted activity output, every measured order has a recognized jurisdiction, and the source measurement reports `passesSourceMeasurementGate=true`. Tax counsel/accounting must review that output, threshold policy, registration/collection status, provider posture, and filing ownership before producing the `TaxNexusReadinessReport`.

Build the Tax gate from the reviewed redacted Tax nexus readiness report instead of hand-editing the packet. The command input should contain only the reviewed `TaxNexusReadinessReport` fields needed for the launch packet.

```powershell
pnpm run marketplace:tax-readiness-evidence -- --nexus-report .\secure\tax-nexus-readiness-2026-05-30.json --reference TAX-READINESS-2026-05-30 --counsel-accounting-approval-reference TAX-COUNSEL-2026-05-30 --state-by-state-nexus-reference TAX-NEXUS-2026-05-30 --provider-decision-reference TAX-PROVIDER-DECISION-2026-05-30 --threshold-policy-reference TAX-THRESHOLD-POLICY-2026-05-30 --nexus-monitoring-reference TAX-NEXUS-MONITORING-2026-05-30
```

The command prints the fields that map into `gates.taxReadiness`, including `thresholdPolicyReference`, `nexusMonitoringReference`, `nexusReportAsOf`, `sourceMeasurementReference`, `sourceMeasurementEnvironment`, `sourceMeasurementQueryVersion`, `sourceMeasurementCheckedAt`, `sourceMeasurementProjectionFreshnessReference`, `sourceMeasurementQueryWindow`, `sourceMeasurementJurisdictionCount`, source measurement coverage counts, `sourceMeasurementRequiresManualReview`, `sourceMeasurementPasses`, and `stateByStateJurisdictionReviewCount`. The launch verifier rejects Tax readiness when the nexus report timestamp is missing, invalid, in the future, older than 30 days, not tied to a production source measurement, not tied to the canonical `tax-nexus-measurement-query/v1`, not tied to a passing source measurement with zero missing or unknown jurisdiction coverage, missing threshold policy evidence, or missing ongoing nexus monitoring evidence. Add `--provider-backed-resolver-composed true` only when a provider-backed `TaxQuoteResolver` is actually composed and verified for production order creation, and include `--provider-backed-resolver-reference` pointing to that production resolver composition and smoke evidence.

Use `posture: "no_collection_required"` only when Tax readiness evidence confirms state-by-state nexus tracking has no collection-required jurisdiction. In that posture, `TAX_PROVIDER_BACKED_QUOTES_REQUIRED=false`.

Use `posture: "provider_backed_quotes_required"` when any jurisdiction is registered or collection-required. In that posture, list the jurisdictions, set `TAX_PROVIDER_BACKED_QUOTES_REQUIRED=true`, and prove a provider-backed `TaxQuoteResolver` is composed before order creation with a concrete `providerBackedResolverReference`.

## Public Claims

Set `ucpAp2Marketing.publicLaunchClaimsEnabled=false` for the current public marketplace launch posture. Agent-commerce, autonomous-payment, AP2, or headless-checkout claims require a separate certification reference before they can appear in public launch marketing.
