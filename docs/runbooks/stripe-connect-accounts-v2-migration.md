# Stripe Connect Accounts v2 migration handoff

This runbook is the Accounts v2 handoff for [#3203](https://github.com/chase-sets/chase-sets/issues/3203), the m68 Stripe Connect Accounts v1 compatibility layer. It documents the current selector, the operational switch, the disposition of existing connected payout accounts, and the cleanup needed after migration.

Live Stripe proof, operator approval, and production evidence remain separately tracked in #3203 and its linked operational issues. This document is not a substitute for those gates.

## Current selector and code path

### Runtime selection

The single selector is `STRIPE_CONNECT_ACCOUNTS_API`. The shared runtime loader accepts only `v1` or `v2` and defaults to `v2` when the variable is absent. It copies the selected value into the Stripe money-movement configuration (`infrastructure/platform-runtime/config-schema.ts:508-556`). The platform API and worker load that configuration at startup (`deployables/platform-api/src/main.ts:102-105`; `deployables/platform-worker/src/main.ts:105-110`) and pass the value to the same Stripe adapter (`deployables/platform-api/src/main.ts:119-127`; `deployables/platform-worker/src/main.ts:145-153`). Representative Commerce State uses the same wiring (`deployables/platform-api/src/representative-commerce-state.ts:227-235`).

Inside `createStripeConnectMoneyMovementGateway`, the value selects one process-wide strategy: `v1` creates the Accounts v1 strategy; every other accepted value selects Accounts v2 (`infrastructure/stripe-connect/index.ts:581-586`, `:627-770`). Settlement and the provider-neutral money-movement contract do not select an Accounts API or receive Stripe account response shapes; the adapter owns that boundary (`docs/adr/0014-stripe-connect-accounts-api-boundary.md:13-19`).

### Which environment value selects v1

The deployment source has a v2 default everywhere. The exact external value that selects v1 is the GitHub `vars.STRIPE_CONNECT_ACCOUNTS_API` value set to the literal `v1`; the workflows pass that value through Terraform and into the runtime environment. If the GitHub variable is unset, the workflow passes `v2`.

- **Preview:** the PR workflow uses `vars.STRIPE_CONNECT_ACCOUNTS_API || 'v2'` for Terraform and passes the resulting value as `STRIPE_CONNECT_ACCOUNTS_API` to the preview deployment (`.github/workflows/platform-pr.yml:876-882`, `:1210-1222`). With the preview variable unset, preview runs v2. The generated Helm defaults also say v2 (`scripts/render-platform-helm-values.mjs:107-112`).
- **Staging:** the staging reset workflow maps `vars.STRIPE_CONNECT_ACCOUNTS_API || 'v2'` into `TF_VAR_stripe_connect_accounts_api` (`.github/workflows/platform-staging-reset.yml:50-55`, `:329-334`, `:419-424`). The #3203 comment records that the staging GitHub environment was intentionally set to `v1` for the compatibility proof; that setting is external to this repository. Thus staging selects v1 only while that environment variable remains `v1`.
- **Production:** the normal production deploy maps the same variable with a v2 fallback (`.github/workflows/platform-production.yml:312-317`, `:635-640`). The production promotion job also forces v2 for a landing-only runtime and otherwise uses `vars.STRIPE_CONNECT_ACCOUNTS_API || 'v2'` (`.github/workflows/platform-production.yml:1660-1665`). Therefore production selects v1 only when an active proof/public production path has the GitHub variable explicitly set to `v1`; the repository default and landing-only path select v2.
- **Runtime injection:** Terraform validates the value as `v1` or `v2`, defaults it to `v2`, and injects it as the runtime `STRIPE_CONNECT_ACCOUNTS_API` for the platform services (`infrastructure/digitalocean/platform/variables.tf:552-560`; `infrastructure/digitalocean/platform/main.tf:938-942`, `:1487-1491`).

In short: v1 is not selected by a code default, an account id prefix, Settlement, or a deployable-specific branch. It is selected only by the process-wide runtime environment value reaching `loadStripeProviderConfig`.

## What changes when Stripe approves Accounts v2

### Fact: this is already an implemented adapter switch

No new application or Settlement code is required merely to select v2. The v2 strategy already exists. A controlled rollout changes the runtime configuration to `STRIPE_CONNECT_ACCOUNTS_API=v2` and redeploys/restarts both platform API and platform worker so their startup configuration is rebuilt.

The selected account strategy changes these operations:

| Operation | v1 strategy | v2 strategy |
| --- | --- | --- |
| Create account | `POST /v1/accounts` with controller properties for dashboard-none and application ownership | `POST /v2/core/accounts` with recipient transfer capability, application responsibilities, and `dashboard: "none"` |
| Retrieve account | `GET /v1/accounts/:id` | `GET /v2/core/accounts/:id` with recipient configuration, requirements, and defaults included |
| Update contact email | `POST /v1/accounts/:id` form body | `POST /v2/core/accounts/:id` JSON body |
| Readiness event | `account.updated` | `v2.core.account[requirements].updated` or `v2.core.account.updated` |

These differences are implemented in `infrastructure/stripe-connect/index.ts:627-766`; the v1 controller-property payload is at `:637-656`, the v2 recipient payload is at `:720-755`, and the strategy selection is at `:770`. The API’s required webhook report follows the same selector (`deployables/platform-api/src/config.ts:335-346`, `:682-768`).

The following operations remain shared and continue to use the existing v1 Stripe resource endpoints in either Accounts posture: manual payout configuration, embedded Account Sessions, hosted Account Links, platform balance reads, platform-to-connected transfers, connected-account payouts, and payout retrieval (`infrastructure/stripe-connect/index.ts:772-800`, `:819-898`, `:900-988`). The switch does not change buyer payment flow, platform-held funds, Settlement ledger behavior, transfer groups, or payout semantics.

### Operational change list

When approval and the separately tracked proof gates are complete:

1. Set the staging GitHub environment variable to `v2`, deploy, and verify the runtime value and v2 readiness webhook report.
2. Register the two v2 readiness events with the Connect webhook destination. Keep `payout.paid` and `payout.failed`; they are shared by both postures (`infrastructure/stripe-connect/index.ts:995-1044`).
3. Confirm every running API and worker instance has restarted with v2 before treating the switch as complete. The webhook parser accepts only the readiness event family belonging to its selected strategy (`infrastructure/stripe-connect/index.ts:682-683`, `:765-766`, `:990-1009`); the current adapter is not a dual-readiness-event compatibility parser.
4. Repeat the separately tracked v2 staging proof, then apply the same configuration change to the active production GitHub environment and redeploy production.
5. Run readiness refresh/reconciliation for retained connected payout accounts after the flip. A provider failure must become an operator-visible migration exception; checkout and payout setup must not silently replace the account.

## Existing v1 account disposition

### Facts supported today

- Settlement stores a provider reference and provider-neutral readiness/posture fields, but no Accounts API version or per-account strategy (`bounded-contexts/settlement/features/payout-readiness/read-model/schema.ts:1-27`).
- If a payout readiness row already has a provider reference, Settlement refreshes that same provider account. It creates a new provider account only when the reference is absent (`bounded-contexts/settlement/features/payout-readiness/api/runtime.ts:421-435`, `:683-709`).
- The adapter then retrieves and updates that reference through the one strategy selected for the whole process. Selecting v2 therefore attempts v2 retrieval/update for an existing `acct_...` reference; selecting v1 uses v1 retrieval/update (`infrastructure/stripe-connect/index.ts:627-716`, `:819-899`).
- There is no per-account v1/v2 routing, v1 fallback after a v2 error, automatic Stripe account replacement, or migration job in the current code. The current code also does not prove that every existing v1 account is readable and operable through Stripe’s v2 recipient endpoints.

### Recommendation

Do not silently mutate or replace existing v1 accounts during checkout, payout setup, or the configuration flip. Keep the global posture on v1 while Operations inventories production `provider_reference` values and proves, using redacted provider-safe evidence, which accounts can operate through the v2 recipient endpoints.

Then use one of these explicit dispositions:

1. **Preferred where v2 compatibility is proven:** retain the existing provider reference, flip the whole runtime to v2, refresh readiness, and monitor/resolve any account-specific v2 blockers.
2. **Retire or deliberately replace:** for an account that cannot operate through v2, block payout operations and have Operations deliberately retire or replace it under the approved account-migration procedure. Do not create a replacement automatically from a checkout or payout-setup request.
3. **If mixed v1/v2 service is required:** implement and test a per-account posture plus dual-strategy routing before flipping production. That is not supported by today’s process-wide selector.

This is intentionally a staged operational decision, not an implicit application migration. Existing v1 accounts should remain on the current global v1 posture until their disposition is recorded; after the global v2 flip, the code does not promise to keep those accounts on v1 endpoints.

## Cleanup checklist

Operations should close these items after the v2 rollout:

- [ ] Record Stripe approval and the separately tracked v2 proof references; do not store raw provider payloads or sensitive account data in the repository or issue comments.
- [ ] Inventory every non-null `settlement_payout_readiness_pages.provider_reference`; classify each account as v2-compatible, deliberately retired/replaced, or blocked for manual review. Include dashboard and responsibility posture in the redacted operations record.
- [ ] Set the staging `STRIPE_CONNECT_ACCOUNTS_API` variable to `v2`, redeploy both API and worker, verify startup health, and verify that the configured Connect readiness events are the v2 events.
- [ ] Before production, configure `v2.core.account[requirements].updated` and `v2.core.account.updated`; retain `payout.paid` and `payout.failed`. Remove the v1 `account.updated` destination only after no v1 runtime or intentionally retained v1 account depends on it. Because the current parser is selected rather than dual, use a controlled rollout and perform a readiness refresh after deployment.
- [ ] Set the active production GitHub variable to `v2` and confirm the landing-only production path is not being used as evidence of the live posture. Redeploy API and worker and verify the actual runtime environment.
- [ ] Run a post-flip readiness refresh for all retained provider references; investigate every v2 retrieval, setup-session, transfer, payout, and webhook failure before declaring migration complete.
- [ ] Remove temporary staging v1 proof overrides and update the private launch/evidence record so it no longer describes v1 as the selected production posture.
- [ ] Once all production connected payout accounts are migrated or intentionally retired, remove the v1 strategy and its tests from `infrastructure/stripe-connect/index.ts`, narrow the config type/default and deploy plumbing in `infrastructure/platform-runtime/config-schema.ts`, the deployable config tests, Terraform, and workflows, then remove the v1 webhook branch from go-live checks and this handoff.
- [ ] Update [Money Operations](./money-operations.md), [ADR 0014](../adr/0014-stripe-connect-accounts-api-boundary.md), and any launch evidence references to the single v2 posture; close the migration issue only after the operational record and cleanup are complete.

The intended end state is one v2 strategy behind the unchanged provider-neutral `MoneyMovementGateway`, with no account-level ambiguity and no long-lived obligation to operate both Accounts API paths.
