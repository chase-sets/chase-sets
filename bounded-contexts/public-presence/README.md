# Public Presence Bounded Context

## Purpose

Public Presence owns Chase Sets public product pages, prelaunch policy surfaces, waitlist behavior, and internal waitlist review.

## Owns

- Public product pages
- Prelaunch policy surfaces
- Versioned public policy artifacts and publication-readiness gates
- Public help articles and their category taxonomy
- Gated developer articles, MCP catalog rendering, and agent-readable documentation manifests
- Waitlist capture and waitlist entries
- Beta wave policy, cohort selection, and waitlist admission
- Internal waitlist review
- Public Referral Code issuance and protected referral-link provisioning
- Landing page positioning and analytics vocabulary

## Does Not Own

- Authenticated account, checkout, or marketplace transactions
- Catalog product truth (referenced, never owned here)
- Notification delivery and preference enforcement

## Ubiquitous Language

Public Presence terminology is defined in [GLOSSARY.md](./GLOSSARY.md).

## Core Aggregates and Process Managers

- Waitlist Signup

## Incoming Dependencies

- Public articles receive reviewed, field-level public policy values through the `publicPolicySources` host port. The platform API composes resolvers from each owning bounded context; Public Presence never queries another context's policy tables or accepts generic policy documents.
- Internal waitlist review receives an authenticated actor at the deployable composition layer (`AuthenticatedApiEnv`) rather than importing Auth or Identity facts directly.
- `identity.account.founders-window-opened` is the access-grant fact that completes the Waitlist Nurture Sequence. Its additive grant-time recipient address lets Public Presence correlate the admitted account to its deterministic Waitlist Signup without querying Identity storage.

## Outgoing Integration Events

- `public-presence.waitlist-signup.admitted` is the durable beta-admission fact. Public Presence projects it into its waitlist read model and transactional-email outbox; Auth reads the admitted-email fact through a platform-api composition port rather than querying this context directly.
- `public-presence.waitlist-signup.recorded`, `public-presence.waitlist-signup.updated`, and `public-presence.waitlist-signup.cohort-quality-provided` remain internal to Public Presence's own waitlist and nurture-email projections.

Public Presence does publish one build-time contract rather than an event: the Help Article compiler derives `@chase-sets/public-docs` article-to-policy citations from canonical frontmatter for Platform Operations' policy-revision review queue.

Developer Articles are a separate, readiness-gated corpus. Their compiler generates a typed article manifest and the MCP tool catalog directly from platform-runtime descriptors. Developer copy never enters the consumer `publicHelpArticles` export.

## Invariants

1. A Waitlist Signup id is derived deterministically from the normalized email address, so a repeat submission from the same email updates the existing signup instead of creating a duplicate.
2. Early-access email consent is implied by joining the waitlist and is recorded automatically at signup time; it is never a required condition of joining. Consent to additional product updates beyond early-access notifications is a separate, optional opt-in.
3. A Waitlist Signup must declare at least one interest.
4. Each nurture touch has one stable idempotency key per Waitlist Signup (and per founders-window start for admission); replaying a source fact can update an unsent outbox row but cannot create or resend a sent delivery.
5. Every newly recorded Waitlist Signup atomically owns one immutable random Public Referral Code and one digest-only uniqueness reservation; replay never generates entropy.

## Tests

Run `pnpm --filter @chase-sets/public-presence run test:watch` for the sub-second watch-mode inner loop. Run `pnpm --filter @chase-sets/public-presence run test` before opening a PR.

## Composition

The marketplace and admin deployables only compose routes from this context. Product copy, waitlist domain behavior, read models, UI, and tests stay here.

## Docs

- [Landing page positioning](docs/landing-page-positioning.md)
- [Landing page analytics](docs/landing-page-analytics.md)
- [Beta wave exposure runbook](../../docs/runbooks/beta-wave-exposure.md)
- [Help article contract](docs/help-article-contract.md)
- [Developer article contract](docs/developer-article-contract.md)
- [Terms of Service publication](docs/terms-of-service-publication.md)
- [Seller migration and bulk-listing proof walkthrough](docs/seller-migration-bulk-listing-proof.md)
