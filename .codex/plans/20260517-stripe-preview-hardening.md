# Stripe Preview Hardening

## Intent

Harden the Stripe integration before go-live by extending automated and preview smoke coverage across buyer payments, wallet balance credit, Connect recipient onboarding, platform-balance transfers, connected-account payouts, provider webhooks, idempotency, and operational diagnostics.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260517-stripe-preview-hardening`
- Branch: `codex/stripe-preview-hardening`
- Sandbox id: `fbdf3833`
- Dependency setup status: complete via `pnpm run deps:install`
- pnpm store path: `.codex/worktrees/.chase-sets-pnpm-store`
- Setup blockers: full payment creation and payout request still require suitable pending-payment order ids and a seller wallet with available balance; baseline preview smoke can now self-register a throwaway seller account.

## Owning Contexts

- Payments owns buyer payment session creation, wallet-credit-adjusted external charge amounts, payment processor references, payment webhooks, refunds, provider idempotency, and payment health.
- Settlement owns wallet balances, ledger entries, payout readiness, payout requests, platform balance forecasts, transfers to connected accounts, connected-account payouts, payout webhooks, and payout health.
- Checkout owns purchase intent and calls Ordering/Payments only after checkout confirmation.
- Ordering owns order commitments and seller economics snapshots that Payments and Settlement consume.
- Infrastructure Stripe adapters own provider-specific API calls and webhook signature verification behind provider-neutral ports.

## Resolved Decisions

- Use Stripe API version `2026-02-25.clover`; official Stripe versioning docs still list it as current on 2026-05-17.
- Keep v1 funds strategy as platform-held buyer payments with on-demand seller payouts. Do not mix direct charges, destination charges, and platform-held charges in this flow.
- Keep Connect account setup in Settlement through the provider-neutral money movement gateway and Stripe Accounts v2 recipient configuration.
- Treat balance credit as Settlement-owned wallet credit applied through the Payments `balanceCreditResolver`; full wallet-covered payments must create a `balance-credit` provider reference and capture without an external Stripe payment amount.
- Expand the smoke test as the preview gate instead of relying only on manual dashboard inspection. It should verify edge security, authenticated seller setup, payment health, payout health, checkout fee/balance-credit status, provider idempotency surfaces, and payout preview behavior.
- Do not store card, bank, tax identity, hosted URL, webhook secret, or raw provider payload data in bounded-context state.

## Open Questions

- Full end-to-end payment creation and payout request need preview test data: pending-payment order ids, desired balance-credit amount, and a seller with available wallet balance. The baseline preview workflow intentionally does not force `SMOKE_CREATE_PAYMENT=true` or `SMOKE_REQUEST_PAYOUT=true` until that data exists.

## Implementation Checklist

- [x] Install worktree dependencies and run sandbox doctor.
- [x] Extend Stripe money smoke coverage for both payment and settlement provider webhook edge rejection.
- [x] Extend smoke coverage for payment provider health, settlement provider health, account status wallet flags, checkout fee policy, provider idempotency surfaces, platform balance forecast, optional balance-credit payment creation, and payout preview/request safety.
- [x] Add focused tests for the smoke script so preview coverage cannot regress silently.
- [x] Add Stripe money smoke to the label-gated PR preview workflow using disposable preview seller registration.
- [x] Review Stripe adapter unit coverage for Accounts v2, payment sessions, balance/transfer/payout calls, webhook mapping, idempotency, and signature failures.
- [x] Run targeted tests for Stripe adapters, money movement, payment processing, platform config, smoke script, and money contexts.
- [x] Run broader verification: metadata, static checks, typecheck, non-DB tests, DB-profile tests, and build.
- [x] Commit changes, push the branch, and open a PR.
- [x] Deploy or push the PR branch to preview using the repo-supported preview workflow.
- [x] Run `pnpm run stripe:money-smoke -- --check-env`, `--edge-check`, and `--seller-flow` against preview with Stripe test-mode credentials.
- [x] Record preview smoke results and any Stripe Dashboard confirmations in the PR.

## Preview Result

- PR: https://github.com/todd-skelton/chase-sets/pull/155
- Latest preview run: https://github.com/todd-skelton/chase-sets/actions/runs/25996222270
- Result on 2026-05-17: all Platform PR checks passed, including label-gated Deploy Preview and Smoke.
- Preview smoke coverage exercised unsigned provider webhook rejection, disposable seller registration/sign-in, payout setup onboarding session creation, payout readiness refresh, payment and settlement provider health, account wallet balance-credit flag, checkout fee policy/status probe, provider idempotency surfaces, platform balance forecast, and payout preview safety.
- Optional full payment creation and payout request remain gated behind explicit preview test data (`SMOKE_ORDER_IDS`, available seller wallet balance, and opt-in create/request flags).

## Documentation To Promote

- Update `docs/runbooks/money-operations.md` if smoke coverage or preview commands change.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
