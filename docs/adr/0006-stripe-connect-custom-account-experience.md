# ADR 0006: Stripe Connect Custom Account Experience

## Status

Accepted

## Context

Chase Sets currently uses Stripe Connect Accounts v2 for recipient payout accounts, but the account experience is still Express-dashboard oriented. The Stripe adapter creates connected accounts with `dashboard: "express"`, creates hosted onboarding Account Links, and creates Express login links for account management. That kept the first payout flow small, but it gives Stripe the primary account-management surface and forces Chase Sets to treat payout setup as a redirect instead of a first-class account workflow.

The marketplace is moving toward a seller experience where accounts can buy and sell from the same workspace, understand payout readiness in Chase Sets language, and recover from setup problems without leaving the account money area. That requires Chase Sets to provide the account-facing Stripe-related functionality when the connected account has no Stripe Dashboard access.

Stripe's Accounts v2 model makes this an explicit responsibility decision rather than a legacy account type. A connected account with `dashboard: "none"` cannot access Stripe Dashboard or Express Dashboard, and the platform must provide the Stripe-related functionality the account needs. Stripe also documents that the platform becomes responsible for collecting KYC requirements only when the platform is responsible for losses and the dashboard is `none`; that state appears as `defaults.responsibilities.requirements_collector: "application"`.

The migration must preserve the existing money movement strategy. Chase Sets intentionally holds purchase funds on the platform, posts seller wallet credit in Settlement, and moves funds to a connected payout account only when an eligible account requests an on-demand payout. The Connect account experience should change how accounts complete payout setup and account management, not silently change charge type, wallet ownership, payout release rules, or platform-balance funding assumptions.

Relevant Stripe documentation:

- [Configure the behavior of connected accounts](https://docs.stripe.com/connect/accounts-v2/connected-account-configuration)
- [Get started with Connect embedded components](https://docs.stripe.com/connect/get-started-connect-embedded-components)
- [Account onboarding embedded component](https://docs.stripe.com/connect/supported-embedded-components/account-onboarding)
- [Account management embedded component](https://docs.stripe.com/connect/supported-embedded-components/account-management)
- [Create an Account Session](https://docs.stripe.com/api/account_sessions/create)

## Decision

Chase Sets will migrate payout accounts to a custom embedded Connect account experience.

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
- Chase Sets does not expose Express Dashboard login links after the migration.

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

Migration sequencing:

- Existing Express-dashboard accounts remain supported until a migration issue defines whether they can be updated in place, must be recreated, or need a mixed-mode bridge.
- The runtime adapter must not switch default account creation to `dashboard: "none"` until preview or staging can create a test payout account, render embedded onboarding, refresh readiness through webhooks and polling, and run a payout smoke path without hosted Account Links.
- Hosted onboarding and Express login links may remain in code behind compatibility paths during migration, but new account-facing product copy should use `payout setup` and `payout account management`, not Express-dashboard terminology.

## Consequences

- Chase Sets owns more compliance-adjacent product responsibility because accounts no longer have a Stripe-hosted dashboard fallback.
- Embedded setup lets payout readiness, support escalation, and account money navigation use the same Chase Sets account language as wallets and payouts.
- The Stripe adapter must add Account Session creation and stop assuming hosted setup URLs are the only payout setup surface.
- Preview and staging need complete Stripe test-mode setup for Connect embedded components, including Account Session endpoints, Connect.js CSP, webhook delivery, and account role checks.
- Support and operations need recovery workflows for requirement updates, embedded component load failures, stale readiness, webhook delays, disabled accounts, and payout destination changes.
- The existing platform-held, on-demand payout architecture remains intact, so this migration does not change seller wallet accounting or the charge strategy.
