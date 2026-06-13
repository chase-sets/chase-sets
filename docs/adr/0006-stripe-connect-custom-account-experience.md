# ADR 0006: Stripe Connect Custom Account Experience

## Status

Accepted and implemented for launch

## Context

Chase Sets uses Stripe Connect Accounts v2 for recipient payout accounts. An earlier implementation kept the account experience Express-dashboard oriented through hosted onboarding Account Links and Express login links. Because the marketplace has not launched, Chase Sets does not need to preserve that compatibility path; payout setup can launch directly as a Chase Sets-owned embedded workflow.

The marketplace is moving toward a seller experience where accounts can buy and sell from the same workspace, understand payout readiness in Chase Sets language, and recover from setup problems without leaving the account money area. That requires Chase Sets to provide the account-facing Stripe-related functionality when the connected account has no Stripe Dashboard access.

Stripe's Accounts v2 model makes this an explicit responsibility decision rather than a legacy account type. A connected account with `dashboard: "none"` cannot access Stripe Dashboard or Express Dashboard, and the platform must provide the Stripe-related functionality the account needs. Stripe also documents that the platform becomes responsible for collecting KYC requirements only when the platform is responsible for losses and the dashboard is `none`; that state appears as `defaults.responsibilities.requirements_collector: "application"`.

The launch implementation must preserve the existing money movement strategy. Chase Sets intentionally holds purchase funds on the platform, posts sale wallet credit in Settlement, and moves funds to a connected payout account only when an eligible account requests an on-demand payout. The Connect account experience changes how accounts complete payout setup and account management, not charge type, wallet ownership, payout release rules, or platform-balance funding assumptions.

Relevant Stripe documentation:

- [Configure the behavior of connected accounts](https://docs.stripe.com/connect/accounts-v2/connected-account-configuration)
- [Get started with Connect embedded components](https://docs.stripe.com/connect/get-started-connect-embedded-components)
- [Account onboarding embedded component](https://docs.stripe.com/connect/supported-embedded-components/account-onboarding)
- [Account management embedded component](https://docs.stripe.com/connect/supported-embedded-components/account-management)
- [Create an Account Session](https://docs.stripe.com/api/account_sessions/create)

## Decision

Chase Sets launches payout accounts with a custom embedded Connect account experience.

Chase Sets chooses Stripe embedded components over full raw API onboarding because the product needs a Chase Sets-owned account workflow, not a Chase Sets-owned verification system. Embedded components keep the account operator in Chase Sets while Stripe continues to render localized requirement collection, verification validation, document upload, service-agreement presentation, and payout destination handling. Full raw API onboarding would add materially more compliance, localization, validation, support, and data-handling responsibility without improving the core marketplace payout workflow.

Target Stripe connected account configuration:

- Accounts are created and managed through Stripe Accounts v2.
- Payout accounts use the recipient configuration required for Stripe balance transfers and payouts.
- `dashboard` is `none`; accounts do not receive Stripe Dashboard or Express Dashboard access.
- `defaults.responsibilities.losses_collector` is `application`.
- `defaults.responsibilities.fees_collector` is `application`.
- `defaults.responsibilities.requirements_collector` must resolve to `application`.
- Payout schedules remain manual or on-demand so Settlement controls when eligible wallet funds are paid out.

Target account experience:

- Chase Sets hosts the payout setup and payout account management pages inside the account money area.
- Chase Sets creates short-lived Account Sessions from authenticated account actions and returns only the client secret needed by Stripe's embedded components.
- Marketplace Web renders Stripe's embedded `account_onboarding` component for first-time or incomplete payout setup.
- Marketplace Web renders Stripe's embedded `account_management` component for later requirement updates and payout destination maintenance.
- Account Sessions are component-scoped to the current Chase Sets user role. Payout setup and account management sessions are available only to users with payout-management permission for the selected account.
- Chase Sets updates Content Security Policy and runtime loading so Connect.js and Stripe embedded frames can render in preview, staging, and production.
- Chase Sets does not expose Express Dashboard login links for launch.

Ownership split:

- Settlement owns payout readiness, connected payout account references, provider-neutral requirement status, payout eligibility, payout requests, wallet debits, payout failure reversals, and reconciliation.
- Marketplace Web owns page composition for account-facing payout setup and account management, using Settlement contracts and design-system components.
- Platform API and platform worker remain composition roots that provide the Stripe money movement adapter and expose Settlement routes.
- Stripe owns verification rules, sensitive requirement collection, embedded component rendering, Stripe service-agreement presentation, payout destination tokenization, provider object state, and signed provider webhooks.
- Support owns first-response triage paths for account operators who cannot complete setup or whose payout destination later requires action.
- Operations and Finance own platform-balance funding, reconciliation cadence, Radar or Connect risk posture, and launch evidence.

Data and security rules:

- Chase Sets stores provider references, provider-neutral readiness statuses, missing requirement identifiers, timestamps, user-safe failure reasons, and reconciliation facts.
- Chase Sets must not store bank account numbers, tax identity values, verification documents, Stripe user credentials, Account Session client secrets after response, webhook signatures, or raw Stripe payload bodies.
- Account Session client secrets must be created server-side for the authenticated account and used only by the browser session that requested them.
- Embedded component access must fail closed if the account membership, selected account, or payout-management permission changes.
- Provider webhooks remain idempotent and must update Settlement-owned readiness facts without trusting browser completion alone.

Launch sequencing:

- Preview and staging must create a test payout account, render embedded onboarding, refresh readiness through webhooks and polling, and run a payout smoke path without hosted Account Links.
- Runtime account creation uses `dashboard: "none"` for launch connected payout accounts.
- Hosted onboarding and Express login links are removed from the launch API and adapter. If provider posture reports `dashboard: "express"` or `dashboard: "full"`, Support and Operations resolve that account outside checkout before production money operations approval.

Rollback strategy:

- If embedded setup fails in preview or staging, fix Account Sessions, CSP, webhook handling, or account-role checks before production approval.
- If embedded setup fails after launch, disable payout setup/session creation, keep webhook processing and reconciliation online, and route affected accounts through support-led recovery.
- Do not roll back by mutating ledger entries, payout release rules, wallet balances, payment charge strategy, or provider webhook storage. The fallback is disabling payout setup/session creation while support resolves provider setup, not changing money movement semantics.

## Consequences

- Chase Sets owns more compliance-adjacent product responsibility because accounts no longer have a Stripe-hosted dashboard fallback.
- Embedded setup lets payout readiness, support escalation, and account money navigation use the same Chase Sets account language as wallets and payouts.
- The Stripe adapter creates Account Sessions and does not expose hosted setup URLs.
- Preview and staging need complete Stripe test-mode setup for Connect embedded components, including Account Session endpoints, Connect.js CSP, webhook delivery, and account role checks.
- Support and operations need recovery workflows for requirement updates, embedded component load failures, stale readiness, webhook delays, disabled accounts, and payout destination changes.
- The existing platform-held, on-demand payout architecture remains intact, so this migration does not change seller wallet accounting or the charge strategy.
