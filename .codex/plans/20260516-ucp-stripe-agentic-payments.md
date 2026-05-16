# UCP Stripe Agentic Payments

## Intent

Build the clean production path for UCP agent commerce: business checkout-term signing, AP2-gated headless completion, Stripe Shared Payment Token handoff through PaymentIntents, and operational visibility over UCP runtime events.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets-20260516-ucp-stripe-agentic-payments`
- Branch: `codex/ucp-stripe-agentic-payments`
- Base: `origin/main` at `2b299b98`
- Dependency setup: `pnpm run deps:install` completed.
- Sandbox: `pnpm run sandbox:doctor` completed with sandbox id `3957ccad`; platform API `http://localhost:8262`, Grafana `http://localhost:8280`.
- Setup blockers: none.

## Owning Contexts

- Checkout owns Checkout Session state, trusted checkout confirmation, and UCP checkout responses.
- Payments owns AP2 Mandate acceptance, payment-handler declarations, payment creation, and provider payment references.
- `contracts/payment-processing` owns provider-neutral processor handoff contracts.
- `infrastructure/stripe-payments` owns Stripe Checkout Session and PaymentIntent adapter behavior.
- `infrastructure/platform-runtime` owns UCP signing, profile metadata, request verification, idempotency, and observer hooks.
- `infrastructure/observability` owns metrics, dashboards, and alerts.
- `deployables/platform-api` remains a thin composition root for env/config wiring.

## Resolved Decisions

- Use Stripe’s current agentic-commerce path as a guarded provider integration: SPTs are private preview, but Stripe documents seller-side use by creating and confirming a PaymentIntent with `shared_payment_granted_token`.
- Keep Checkout’s trusted UI fallback as the default. Headless completion only proceeds when AP2 verification and a provider-backed agentic payment handoff are both configured and pass.
- Use UCP AP2 detached merchant authorization over a JCS-canonicalized checkout payload excluding `ap2`, with ES256/ES384/ES512 key support.
- Publish business signing public keys in the UCP business profile when configured, so platform agents can bind checkout mandates to our terms.
- Treat real AP2 SD-JWT+KB verification as a Payments-owned pluggable verifier. The platform will expose the runtime hook and evidence shape now; default runtime stays closed until a verifier is configured.
- Record Stripe SPT payments as normal Payments-owned payments with `processor_payment_kind = payment-intent`, idempotency records, metadata, and webhook behavior.
- Add UCP metrics and Grafana panels/alerts from existing observer events instead of moving observability decisions into UCP or deployables.

## Open Questions

- None blocking. Stripe SPT access is private preview, so live production enablement still requires Stripe account approval and the final AP2 verifier/certification setup.

## Implementation Checklist

- [x] Add UCP business signing key types, JCS canonicalization, detached JWS signing, and public signing-key profile publication.
- [x] Sign Checkout UCP responses with `ap2.merchant_authorization` when signing keys are configured.
- [x] Add Payments AP2 verifier and agentic payment handler contracts with closed-by-default behavior.
- [x] Extend Payments creation path and Stripe adapter for SPT-backed PaymentIntent creation.
- [x] Let UCP checkout completion reuse the existing Checkout confirmation path after AP2 verification and agentic payment readiness.
- [x] Add UCP observability metrics, Grafana panels, and alerts.
- [x] Update architecture/runbook/glossary docs for the production gate and remaining external prerequisites.
- [x] Verify focused tests, workspace static checks, typecheck, non-DB tests, DB tests, and build locally.
- [ ] Open PR, ensure GitHub CI passes, merge, and complete post-merge verification.

## Documentation To Promote

- `docs/architecture/ucp-agent-commerce.md`
- `docs/runbooks/ucp-agent-commerce.md`
- `docs/runbooks/observability.md`
- Payments and Checkout glossaries if the implementation introduces new ubiquitous terms.

## Goal Completion Criteria

- Implementation remains in this worktree and branch with this plan retained.
- Product/runtime/docs/tests are updated in owning contexts only.
- Automated checks pass locally and in GitHub CI.
- UCP profile, checkout signing, AP2 fallback, Stripe SPT PaymentIntent handoff, and UCP observer metrics have focused coverage.
- PR is opened, CI passes, PR is merged, and post-merge main CI/deploy verification is checked where available.
